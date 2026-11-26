import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { FlightRecorderPage, FlightRecorderRow } from "@redcode-ai/sdk/v2/client"
import {
  FlightRecorderSection,
  type FlightRecorderLoad,
  type FlightRecorderLoadInput,
  type FlightRecorderTranslate,
} from "./session-flight-recorder"

// 261126 Red Flight Recorder 的离线 UI 覆盖：懒开、来源切换、低点详情、快速切会话、
// 错误/空态重试与分页。全部走注入的 loadPage，不碰 live DB/API。

const templates: Record<string, string> = {
  "context.flightRecorder.cap": "client-limit {{count}} not loaded",
  "context.flightRecorder.coverage": "coverage {{covered}}/{{total}}",
  "context.flightRecorder.costCoverage": "cost {{covered}}/{{total}}",
  "context.flightRecorder.lowPoint": "lowest {{percent}} · {{time}}",
  "context.flightRecorder.diagnostics.firstDifference": "entry {{index}}",
  "context.flightRecorder.scope": "loaded {{count}} oldest {{oldest}}",
  "context.flightRecorder.requestsNote": "server retention configurable eviction unknown",
  "context.flightRecorder.end.steps": "no earlier steps",
  "context.flightRecorder.end.requests": "queryable end eviction unknown",
  "context.flightRecorder.field.request": "linked request",
  "context.flightRecorder.field.request.open": "open linked request",
  "context.flightRecorder.field.request.missing": "request {{request}} not in loaded rows; eviction unknown",
  "context.flightRecorder.field.request.error": "request search failed {{error}}",
  "context.flightRecorder.field.request.retry": "retry request search",
  "context.flightRecorder.field.unassociated": "unassociated",
  "context.flightRecorder.costNote": "cost is the step total only",
}

const t: FlightRecorderTranslate = (key, params) =>
  (templates[key] ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_, name: string) => String(params?.[name] ?? `{{${name}}}`),
  )

let sequence = 0
function row(overrides: Partial<FlightRecorderRow> = {}): FlightRecorderRow {
  sequence++
  return {
    id: `row-${sequence}`,
    messageID: `msg-${sequence}`,
    time: 1_700_000_000_000 + sequence * 1_000,
    modelID: "test-model",
    providerID: "test-provider",
    outcome: "completed",
    input: 100,
    output: 10,
    cacheRead: 50,
    cacheWrite: 0,
    cacheMiss: 50,
    cost: 0.01,
    currency: "USD",
    durationMs: 1_200,
    firstEventMs: 300,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function responder(handler: (input: FlightRecorderLoadInput) => FlightRecorderPage | Promise<FlightRecorderPage>) {
  const calls: FlightRecorderLoadInput[] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    return handler(input)
  }
  return { calls, load }
}

const flush = async () => {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function click(container: ParentNode, selector: string) {
  const element = container.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`missing ${selector}`)
  element.click()
}

function mount(
  loadPage: FlightRecorderLoad,
  options: {
    sessionID?: () => string | undefined
    pageSize?: number
    maxRows?: number
    onOpenGlobal?: () => void
  } = {},
) {
  const [session, setSession] = createSignal(options.sessionID?.() ?? "session-1")
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => (
      <FlightRecorderSection
        sessionID={() => session()}
        loadPage={loadPage}
        t={t}
        locale={() => "en-US"}
        pageSize={options.pageSize}
        maxRows={options.maxRows}
        onOpenGlobal={options.onOpenGlobal}
      />
    ),
    container,
  )
  return {
    container,
    setSession,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

async function open(container: ParentNode) {
  click(container, '[data-testid="flight-recorder-toggle"]')
  await flush()
}

test("flight recorder is lazy: no request and no panel until expanded", async () => {
  const fake = responder(() => ({ items: [row()] }))
  const mounted = mount(fake.load)
  try {
    await flush()
    expect(fake.calls.length).toBe(0)
    expect(mounted.container.querySelector('[data-testid="flight-recorder-panel"]')).toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-state"]')?.textContent).toContain(
      "context.flightRecorder.expand",
    )

    await open(mounted.container)
    expect(fake.calls.length).toBe(1)
    expect(fake.calls[0]?.source).toBe("steps")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-panel"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-state"]')?.textContent).toContain(
      "context.flightRecorder.collapse",
    )
  } finally {
    mounted.dispose()
  }
})

test("switching source replaces steps with actual requests and keeps the scope explicit", async () => {
  const steps = row({ id: "step-1", modelID: "steps-model" })
  const request = row({ id: "request-1", modelID: "request-model" })
  const fake = responder((input) => ({
    items: [input.source === "steps" ? steps : request],
  }))
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    expect(mounted.container.querySelector('[data-row-id="step-1"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-row-id="request-1"]')).toBeNull()

    click(mounted.container, '[data-testid="flight-recorder-source-requests"]')
    await flush()
    expect(fake.calls.length).toBe(2)
    expect(fake.calls[1]?.source).toBe("requests")
    expect(mounted.container.querySelector('[data-row-id="step-1"]')).toBeNull()
    expect(mounted.container.querySelector('[data-row-id="request-1"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-note"]')?.textContent).toContain(
      "server retention configurable",
    )
    // 服务端容量可配置：会话接口不返回策略时不能声称 128 是当前生效上限。
    expect(mounted.container.querySelector('[data-testid="flight-recorder-note"]')?.textContent).not.toContain("128")
  } finally {
    mounted.dispose()
  }
})

test("step requestID links to a loaded request and never guesses eviction", async () => {
  const linked = { ...row({ id: "step-linked" }), requestID: "req_target" }
  const unlinked = row({ id: "step-unlinked" })
  const missing = { ...row({ id: "step-missing" }), requestID: "req_missing" }
  const target = row({ id: "req_target", outcome: "failed" })
  const fake = responder((input) => ({
    items: input.source === "steps" ? [linked, unlinked, missing] : [target],
  }))
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    click(mounted.container, '[data-row-id="step-linked"] button')
    await flush()
    const linkedDetail = mounted.container.querySelector('[data-testid="flight-recorder-detail"]')!
    expect(linkedDetail.textContent).toContain("req_target")
    expect(linkedDetail.textContent).toContain("linked request")
    expect(linkedDetail.textContent).toContain("cost is the step total only")

    click(mounted.container, '[data-testid="flight-recorder-open-request"]')
    await flush()
    await flush()
    // 关联请求就在按需加载的请求列表里：切到 requests 并展开它，费用说明不再属于它。
    expect(mounted.container.querySelector('[data-row-id="req_target"]')).not.toBeNull()
    const requestDetail = mounted.container.querySelector('[data-testid="flight-recorder-detail"]')!
    expect(requestDetail.getAttribute("data-detail-id")).toBe("req_target")
    expect(requestDetail.textContent).not.toContain("cost is the step total only")
    expect(requestDetail.textContent).not.toContain("linked request")

    click(mounted.container, '[data-testid="flight-recorder-source-steps"]')
    await flush()
    click(mounted.container, '[data-row-id="step-unlinked"] button')
    await flush()
    const unlinkedDetail = mounted.container.querySelector('[data-testid="flight-recorder-detail"]')!
    expect(unlinkedDetail.textContent).toContain("unassociated")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-open-request"]')).toBeNull()

    // 请求不在已加载列表：明确“未找到、淘汰未知”，不把它说成一定已淘汰。
    click(mounted.container, '[data-row-id="step-missing"] button')
    await flush()
    click(mounted.container, '[data-testid="flight-recorder-open-request"]')
    await flush()
    await flush()
    const note = mounted.container.querySelector('[data-testid="flight-recorder-request-missing"]')
    expect(note?.textContent).toContain("req_missing")
    expect(note?.textContent).toContain("eviction unknown")
  } finally {
    mounted.dispose()
  }
})

test("request-link search stops on a load error and can retry", async () => {
  const linked = { ...row({ id: "step-link" }), requestID: "req_retry" }
  const target = row({ id: "req_retry", outcome: "failed" })
  let more = 0
  const fake = responder((input) => {
    if (input.source === "steps") return { items: [linked] }
    if (!input.before) return { items: [row({ id: "req_other" })], next: "cursor-1" }
    more++
    if (more === 1) throw new Error("network down")
    return { items: [target] }
  })
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    click(mounted.container, '[data-row-id="step-link"] button')
    await flush()
    click(mounted.container, '[data-testid="flight-recorder-open-request"]')
    await flush()
    await flush()
    // 分页失败后不能保留 next 自动重试；只允许一次失败请求，然后停下来等人工重试。
    expect(more).toBe(1)
    const failure = mounted.container.querySelector('[data-testid="flight-recorder-request-error"]')
    expect(failure?.textContent).toContain("network down")
    expect(
      mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.getAttribute("data-detail-id"),
    ).not.toBe("req_retry")

    click(mounted.container, '[data-testid="flight-recorder-request-retry"]')
    await flush()
    await flush()
    expect(more).toBe(2)
    expect(
      mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.getAttribute("data-detail-id"),
    ).toBe("req_retry")
  } finally {
    mounted.dispose()
  }
})

test("ledger hit rate includes booked zero cache, excludes estimates/anomalies, and reveals the low-point detail", async () => {
  const zero = row({ id: "zero", messageID: "msg-zero", input: 100, cacheRead: 0, outcome: "booked" })
  const low = row({ id: "low", messageID: "msg-low", input: 100, cacheRead: 10, outcome: "completed" })
  const middle = row({ id: "middle", input: 100, cacheRead: 50, outcome: "booked" })
  const high = row({ id: "high", messageID: "msg-high", input: 100, cacheRead: 90, outcome: "failed" })
  const estimated = row({ id: "estimated", input: 100, cacheRead: 0, outcome: "estimated" })
  const anomaly = row({ id: "anomaly", input: 100, cacheRead: 150, outcome: "completed" })
  const fake = responder(() => ({ items: [zero, low, middle, high, estimated, anomaly] }))
  const mounted = mount(fake.load)
  const scrolled: string[] = []
  const original = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.getAttribute("data-detail-id") ?? "")
  }
  try {
    await open(mounted.container)
    expect(mounted.container.querySelector('[data-testid="flight-recorder-ratio-label"]')?.textContent).toBe(
      "context.flightRecorder.ledgerCacheRatio",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-ratio"]')?.textContent).toBe("37.5%")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-coverage"]')?.textContent).toContain("4/6")

    const lowPoint = mounted.container.querySelector('[data-testid="flight-recorder-low-point"]')
    expect(lowPoint?.textContent).toContain("0%")
    ;(lowPoint as HTMLElement).click()
    await flush()
    expect(scrolled).toContain("zero")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain("msg-zero")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.prefix.missing.steps",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.ledgerCacheNote",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.field.cacheMiss.steps",
    )

    // 行本身也能展开；同一时间只开一条，选中态跟随 id 而不是索引。
    click(mounted.container, '[data-row-id="high"] button')
    await flush()
    expect(scrolled).toContain("high")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain("msg-high")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).not.toContain("msg-zero")
  } finally {
    HTMLElement.prototype.scrollIntoView = original
    mounted.dispose()
  }
})

test("requests hit rate only uses reported values and keeps request-specific prefix wording", async () => {
  const zero = row({ id: "req-zero", messageID: "msg-req-zero", input: 100, cacheRead: 0, outcome: "completed" })
  const full = row({
    id: "req-full",
    messageID: "msg-req-full",
    input: 100,
    cacheRead: 100,
    outcome: "completed",
    prefix: { system: "unchanged", tools: "unchanged", history: "append", compressed: false },
  })
  const estimated = row({ id: "req-estimated", outcome: "estimated", input: undefined, cacheRead: undefined })
  const fake = responder(() => ({ items: [zero, full, estimated] }))
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    click(mounted.container, '[data-testid="flight-recorder-source-requests"]')
    await flush()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-ratio-label"]')?.textContent).toBe(
      "context.flightRecorder.cacheRatio",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-ratio"]')?.textContent).toBe("50%")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-coverage"]')?.textContent).toContain("2/3")

    click(mounted.container, '[data-row-id="req-full"] button')
    await flush()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.prefix.noNewCompaction",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.prefix.compactionNote",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.field.cacheMiss",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).not.toContain(
      "context.flightRecorder.field.cacheMiss.steps",
    )

    click(mounted.container, '[data-row-id="req-zero"] button')
    await flush()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).toContain(
      "context.flightRecorder.prefix.missing.requests",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-detail"]')?.textContent).not.toContain(
      "context.flightRecorder.prefix.missing.steps",
    )
  } finally {
    mounted.dispose()
  }
})

test("request diagnostics show the actual prior capture, the first difference, and reported attribution", async () => {
  const section = { change: "unchanged", count: 1, bytes: 50, countDelta: 0, bytesDelta: 0 } as const
  const prior = row({ id: "baseline-request", cacheRead: 98 })
  const adjacent = row({ id: "other-bucket-request", cacheRead: 65 })
  const low = row({
    id: "low-request",
    cacheRead: 32,
    diagnostics: {
      version: 1,
      runtime: "ai-sdk",
      capture: {
        status: "captured",
        previousRequestID: prior.id,
        system: section,
        tools: section,
        history: { ...section, change: "rewrite", firstDifference: 0 },
        parameters: "unchanged",
        wire: "changed",
        serialized: "changed",
        affinity: "unchanged",
      },
      instructions: { source: "provider", inputTokens: 30, cachedTokens: 0, missTokens: 30 },
      unattributedInputTokens: 38,
    },
  })
  const mounted = mount(async () => ({ items: [low, adjacent, prior] }))
  try {
    await open(mounted.container)
    click(mounted.container, '[data-testid="flight-recorder-source-requests"]')
    await flush()
    click(mounted.container, '[data-row-id="low-request"] button')
    const detail = mounted.container.querySelector('[data-testid="flight-recorder-diagnostics"]')?.textContent
    expect(detail).toContain("baseline-request")
    expect(detail).toContain("98%")
    expect(detail).not.toContain("65%")
    expect(detail).toContain("entry 1")
    expect(detail).toContain("cachedTokens0")
    expect(detail).toContain("cacheWriteTokens—")
    expect(detail).toContain("unattributed38")
  } finally {
    mounted.dispose()
  }
})

test("rapid session switch discards the late response from the old session", async () => {
  const first = deferred<FlightRecorderPage>()
  const second = deferred<FlightRecorderPage>()
  const calls: FlightRecorderLoadInput[] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    return calls.length === 1 ? first.promise : second.promise
  }
  const mounted = mount(load)
  try {
    await open(mounted.container)
    expect(calls.length).toBe(1)

    mounted.setSession("session-2")
    await flush()
    expect(calls.length).toBe(2)
    expect(calls[1]?.sessionID).toBe("session-2")

    second.resolve({ items: [row({ id: "new-session", messageID: "msg-new" })] })
    await flush()
    expect(mounted.container.querySelector('[data-row-id="new-session"]')).not.toBeNull()

    first.resolve({ items: [row({ id: "old-session", messageID: "msg-old" })] })
    await flush()
    expect(mounted.container.querySelector('[data-row-id="old-session"]')).toBeNull()
    expect(mounted.container.querySelector('[data-row-id="new-session"]')).not.toBeNull()
  } finally {
    mounted.dispose()
  }
})

test("definite errors can retry into an empty state; the requests source has its own empty copy", async () => {
  let attempt = 0
  const fake = responder((input) => {
    attempt++
    if (attempt === 1) throw new Error("boom")
    return { items: [] }
  })
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    expect(mounted.container.querySelector('[data-testid="flight-recorder-error"]')).not.toBeNull()
    expect(mounted.container.textContent).toContain("boom")

    click(mounted.container, '[data-testid="flight-recorder-retry"]')
    await flush()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-error"]')).toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-empty"]')?.textContent).toContain(
      "context.flightRecorder.empty.steps",
    )

    click(mounted.container, '[data-testid="flight-recorder-source-requests"]')
    await flush()
    expect(fake.calls.at(-1)?.source).toBe("requests")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-empty"]')?.textContent).toContain(
      "context.flightRecorder.empty.requests",
    )
  } finally {
    mounted.dispose()
  }
})

test("paging uses the next cursor, de-duplicates rows and stops at the retention cap", async () => {
  const first = row({ id: "r1" })
  const second = row({ id: "r2" })
  const third = row({ id: "r3" })
  const fourth = row({ id: "r4" })
  const fake = responder((input) => {
    if (!input.before) return { items: [first, second], next: "cursor-1" }
    if (input.before === "cursor-1") return { items: [second, third, fourth], next: "cursor-2" }
    return { items: [], next: undefined }
  })
  const mounted = mount(fake.load, { maxRows: 3 })
  try {
    await open(mounted.container)
    expect(mounted.container.querySelectorAll('[data-testid="flight-recorder-row"]').length).toBe(2)

    click(mounted.container, '[data-testid="flight-recorder-load-more"]')
    await flush()
    expect(fake.calls.length).toBe(2)
    expect(fake.calls[1]?.before).toBe("cursor-1")
    const ids = Array.from(mounted.container.querySelectorAll('[data-testid="flight-recorder-row"]')).map((element) =>
      element.getAttribute("data-row-id"),
    )
    expect(ids).toEqual(["r1", "r2", "r3"])
    expect(mounted.container.querySelector('[data-testid="flight-recorder-load-more"]')).toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-cap"]')?.textContent).toContain(
      "client-limit 3 not loaded",
    )
    expect(mounted.container.querySelector('[data-testid="flight-recorder-end"]')).toBeNull()
    expect(fake.calls.length).toBe(2)
  } finally {
    mounted.dispose()
  }
})

test("exactly the request retention limit without a cursor keeps the range bounded and eviction unknown", async () => {
  const rows = Array.from({ length: 128 }, (_, index) =>
    row({ id: `retained-${index}`, time: 1_700_000_000_000 - index * 1_000 }),
  )
  const fake = responder(() => ({ items: rows }))
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    click(mounted.container, '[data-testid="flight-recorder-source-requests"]')
    await flush()
    expect(mounted.container.querySelectorAll('[data-testid="flight-recorder-row"]').length).toBe(128)
    expect(mounted.container.querySelector('[data-testid="flight-recorder-cap"]')).toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-load-more"]')).toBeNull()

    const fmt = new Intl.DateTimeFormat("en-US", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    const scope = mounted.container.querySelector('[data-testid="flight-recorder-scope"]')?.textContent
    expect(scope).toContain("loaded 128")
    expect(scope).toContain(fmt.format(new Date(rows[rows.length - 1]!.time)))

    expect(mounted.container.querySelector('[data-testid="flight-recorder-note"]')?.textContent).toContain(
      "server retention configurable eviction unknown",
    )
    // 恰好 128 且没有 next：不称“全部历史”，也不声称已淘汰，只说明范围末端且淘汰未知。
    expect(mounted.container.querySelector('[data-testid="flight-recorder-end"]')?.textContent).toBe(
      "queryable end eviction unknown",
    )
  } finally {
    mounted.dispose()
  }
})

test("client-side truncation at the same limit is reported as unloaded, not evicted", async () => {
  const rows = Array.from({ length: 128 }, (_, index) => row({ id: `capped-${index}` }))
  const fake = responder(() => ({ items: rows, next: "cursor-more" }))
  const mounted = mount(fake.load)
  try {
    await open(mounted.container)
    click(mounted.container, '[data-testid="flight-recorder-source-requests"]')
    await flush()
    expect(mounted.container.querySelectorAll('[data-testid="flight-recorder-row"]').length).toBe(128)
    expect(mounted.container.querySelector('[data-testid="flight-recorder-end"]')).toBeNull()
    expect(mounted.container.querySelector('[data-testid="flight-recorder-load-more"]')).toBeNull()

    const cap = mounted.container.querySelector('[data-testid="flight-recorder-cap"]')?.textContent
    expect(cap).toContain("client-limit 128 not loaded")
    expect(mounted.container.querySelector('[data-testid="flight-recorder-note"]')?.textContent).toContain(
      "server retention configurable eviction unknown",
    )
  } finally {
    mounted.dispose()
  }
})