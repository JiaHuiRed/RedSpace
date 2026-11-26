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
  "context.flightRecorder.cap": "cap {{count}}",
  "context.flightRecorder.coverage": "coverage {{covered}}/{{total}}",
  "context.flightRecorder.costCoverage": "cost {{covered}}/{{total}}",
  "context.flightRecorder.lowPoint": "lowest {{percent}} · {{time}}",
  "context.flightRecorder.diagnostics.firstDifference": "entry {{index}}",
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
  options: { sessionID?: () => string | undefined; pageSize?: number; maxRows?: number } = {},
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
    expect(mounted.container.textContent).toContain("context.flightRecorder.requestsNote")
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
    expect(mounted.container.querySelector('[data-testid="flight-recorder-cap"]')?.textContent).toContain("3")
    expect(fake.calls.length).toBe(2)
  } finally {
    mounted.dispose()
  }
})
