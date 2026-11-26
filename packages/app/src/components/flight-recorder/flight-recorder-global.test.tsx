import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { FlightRecorderRow } from "@redcode-ai/sdk/v2/client"
import {
  FlightRecorderGlobalPanel,
  flightRecorderGlobalHitRate,
  flightRecorderGlobalLowest,
  flightRecorderGlobalWindow,
  type FlightRecorderGlobalFilters,
  type FlightRecorderGlobalLoadRows,
  type FlightRecorderGlobalLoadSummary,
  type FlightRecorderGlobalLoadWorkspaces,
  type FlightRecorderGlobalPage,
  type FlightRecorderGlobalRow,
  type FlightRecorderGlobalStepSummary,
  type FlightRecorderGlobalSummary,
  type FlightRecorderGlobalUsage,
  type FlightRecorderGlobalRequestSummary,
  type FlightRecorderGlobalRowsInput,
} from "./flight-recorder-global"
import type { FlightRecorderTranslate } from "@/components/session/session-flight-recorder"
import * as flightRecorderGlobalModule from "./flight-recorder-global"

// 261126 Red FR-04 全局面板的离线覆盖：懒加载一次、双账本独立、时间/会话筛选、
// 分页与扫描截断、详情跳转与安全失败、错误重试。全部走注入 loader，不碰 live DB/API。

const NOW = 1_700_000_000_000

const templates: Record<string, string> = {
  "flightRecorder.global.loading": "loading",
  "flightRecorder.global.ledger.note": "The two ledgers are aggregated separately; do not add their counts together.",
  "flightRecorder.global.retry": "retry",
  "flightRecorder.global.filter.range.all": "all retained",
  "flightRecorder.global.filter.range.24h": "24 hours",
  "flightRecorder.global.filter.range.7d": "7 days",
  "flightRecorder.global.filter.range.30d": "30 days",
  "flightRecorder.global.stat.samples": "{{count}} records",
  "flightRecorder.global.stat.sessionsValue": "{{main}} main / {{sub}} sub",
  "flightRecorder.global.stat.hitRate": "Weighted cache hit rate",
  "flightRecorder.global.stat.hitRateDetail": "read {{read}} / input {{input}}",
  "flightRecorder.global.stat.hitSamples": "{{samples}} valid / {{invalid}} invalid / {{incomplete}} incomplete",
  "flightRecorder.global.stat.ownershipValue": "{{main}} main / {{sub}} sub / {{output}} output",
  "flightRecorder.global.stat.booked": "booked {{count}}",
  "flightRecorder.global.stat.estimated": "estimated {{count}}",
  "flightRecorder.global.stat.failed": "failed {{count}}",
  "flightRecorder.global.stat.cancelled": "cancelled {{count}}",
  "flightRecorder.global.stat.unknown": "unknown {{count}}",
  "flightRecorder.global.stat.noLatency": "no latency",
  "flightRecorder.global.stat.latency": "duration {{p50}} / {{p95}} / {{max}}",
  "flightRecorder.global.stat.firstEvent": "first event {{p50}} / {{p95}} / {{max}}",
  "flightRecorder.global.stat.costBucket": "{{currency}} booked {{booked}} estimated {{estimated}}",
  "flightRecorder.global.stat.costBucketMissing": "{{currency}} booked {{booked}} estimated {{estimated}} missing {{missing}}",
  "flightRecorder.global.window.ledger": "{{scanned}} scanned {{from}} - {{to}}",
  "flightRecorder.global.window.scan": "summary scan {{scan}} page scan {{pageScan}}",
  "flightRecorder.global.window.retention": "server retention {{retention}}",
  "flightRecorder.global.window.retentionUnknown": "retention not reported",
  "flightRecorder.global.window.truncated": "window partial; older rows not examined",
  "flightRecorder.global.window.breakdowns": "breakdowns truncated {{groups}} {{days}}",
  "flightRecorder.global.groups.stepsLine": "{{count}} steps hit {{rate}} ({{valid}}) {{cost}}",
  "flightRecorder.global.groups.requestsLine": "{{count}} requests hit {{rate}} ({{valid}}) failed {{failed}} p95 {{p95}}",
  "flightRecorder.global.trend.failed": "{{count}} failed",
  "flightRecorder.global.rows.scanned": "scanned {{count}}",
  "flightRecorder.global.rows.scope": "loaded {{count}} oldest {{oldest}}",
  "flightRecorder.global.rows.cap": "client cap {{count}} not loaded",
  "flightRecorder.global.rows.emptyWithNext": "empty this scan window",
  "flightRecorder.global.rows.lowest": "lowest {{percent}} {{time}}",
  "flightRecorder.global.rows.session": "session {{id}}",
  "flightRecorder.global.detail.jumpFailed": "jump failed {{error}}",
  "flightRecorder.global.detail.kind.main": "main session",
  "flightRecorder.global.detail.kind.sub": "subagent session",
  "context.flightRecorder.field.request": "linked request",
  "context.flightRecorder.field.request.open": "open linked request",
  "context.flightRecorder.field.request.missing": "request {{request}} not in loaded rows; eviction unknown",
  "context.flightRecorder.field.unassociated": "unassociated",
  "context.flightRecorder.field.cost": "cost",
  "context.flightRecorder.costNote": "step total only",
  "flightRecorder.global.scope.line": "{{server}} {{project}} {{workspace}}",
  "flightRecorder.global.scope.allWorkspaces": "all workspaces",
  "flightRecorder.global.scope.workspaceScope": "server workspace scope",
  "flightRecorder.global.scope.note": "current server and project only; workspace scope is not universal",
  "flightRecorder.global.description": "{{server}} {{project}}",
  "flightRecorder.global.filter.provider.placeholder": "provider id manual",
  "flightRecorder.global.filter.model.placeholder": "model id manual",
  "flightRecorder.global.filter.apply": "apply",
  "flightRecorder.global.workspaces.error": "workspace list failed {{error}}",
  "flightRecorder.global.workspaces.retry": "retry workspaces",
  "flightRecorder.global.request.error": "request search failed {{error}}",
  "flightRecorder.global.request.retry": "retry request search",
}

const t: FlightRecorderTranslate = (key, params) =>
  (templates[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? `{{${name}}}`))

const usage = (overrides: Partial<FlightRecorderGlobalUsage> = {}): FlightRecorderGlobalUsage => ({
  samples: 1,
  input: 100,
  output: 10,
  cacheRead: 90,
  cacheWrite: 0,
  cacheMiss: 10,
  cache: { input: 100, read: 90, samples: 1, excluded: { invalid: 0, incomplete: 0 } },
  ...overrides,
})

const steps = (overrides: Partial<FlightRecorderGlobalStepSummary> = {}): FlightRecorderGlobalStepSummary => ({
  samples: 1,
  sessions: { main: 1, sub: 0 },
  usage: usage(),
  outcomes: { booked: 1, estimated: 0 },
  cost: [{ currency: "USD", booked: 0.25, estimated: 0.1, samples: 2, missing: 1 }],
  ...overrides,
})

const requests = (overrides: Partial<FlightRecorderGlobalRequestSummary> = {}): FlightRecorderGlobalRequestSummary => ({
  samples: 1,
  sessions: { main: 1, sub: 0 },
  usage: usage({ input: 200, cacheRead: 40, cacheMiss: 160, cache: { input: 200, read: 40, samples: 1, excluded: { invalid: 0, incomplete: 0 } } }),
  outcomes: { completed: 1, failed: 1, cancelled: 0, unknown: 0 },
  latency: { samples: 1, durationMs: { p50: 1200, p95: 2000, max: 2400 }, firstEventMs: { p50: 300, p95: 500, max: 600 } },
  ...overrides,
})

const group = () => ({ steps: steps(), requests: requests() })

function summary(overrides: Partial<FlightRecorderGlobalSummary> = {}): FlightRecorderGlobalSummary {
  return {
    steps: steps({ samples: 3, sessions: { main: 2, sub: 1 } }),
    requests: requests({ samples: 2, sessions: { main: 1, sub: 1 } }),
    ownership: {
      steps: { main: usage({ samples: 2, output: 20 }), sub: usage({ samples: 1, output: 5 }) },
      requests: { main: usage({ samples: 1, output: 8 }), sub: usage({ samples: 1, output: 2 }) },
    },
    models: [{ providerID: "test-provider", modelID: "test-model", ...group() }],
    workspaces: [
      // 生成 SDK 把 workspaceID 标成 string；空串与运行时 null 在 UI 里同样是本地工作区。
      { workspaceID: "", ...group() },
      { workspaceID: "wrk_feature", ...group() },
    ],
    daily: [{ day: "2026-11-25", ...group() }],
    coverage: {
      steps: { from: NOW - 1000, to: NOW, scanned: 4, truncated: false },
      requests: { from: NOW - 900, to: NOW, scanned: 3, truncated: false },
    },
    truncated: false,
    breakdownsTruncated: false,
    limits: { scan: 5000, pageScan: 1000, groups: 50, trendDays: 60 },
    retention: { requestsPerSession: 128 },
    ...overrides,
  }
}

let sequence = 0
function row(overrides: Partial<FlightRecorderGlobalRow> = {}): FlightRecorderGlobalRow {
  sequence++
  return {
    id: `row-${sequence}`,
    sessionID: "ses_main",
    messageID: `msg-${sequence}`,
    time: NOW - sequence * 1000,
    providerID: "test-provider",
    modelID: "test-model",
    outcome: "completed",
    input: 100,
    output: 10,
    cacheRead: 50,
    cacheWrite: 0,
    cacheMiss: 50,
    durationMs: 1200,
    firstEventMs: 300,
    sub: false,
    ...overrides,
  }
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

type Harness = {
  container: HTMLElement
  dispose: () => void
  summaryCalls: FlightRecorderGlobalFilters[]
  rowCalls: FlightRecorderGlobalRowsInput[]
  opened: string[]
}

function mount(options: {
  summary?: FlightRecorderGlobalLoadSummary
  rows?: FlightRecorderGlobalLoadRows
  workspaces?: FlightRecorderGlobalLoadWorkspaces
  pageSize?: number
  maxRows?: number
  onOpenSession?: (sessionID: string) => Promise<void>
} = {}): Harness {
  const summaryCalls: FlightRecorderGlobalFilters[] = []
  const rowCalls: FlightRecorderGlobalRowsInput[] = []
  const opened: string[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => (
      <FlightRecorderGlobalPanel
        serverName="test-server"
        projectName="test-project"
        now={() => NOW}
        locale={() => "en-US"}
        t={t}
        pageSize={options.pageSize}
        maxRows={options.maxRows}
        loadSummary={async (filters) => {
          summaryCalls.push({ ...filters })
          return options.summary ? options.summary(filters) : summary()
        }}
        loadRows={async (input) => {
          rowCalls.push({ ...input })
          return options.rows ? options.rows(input) : { items: [row()], scanned: 1, truncated: false }
        }}
        loadWorkspaces={options.workspaces}
        onOpenSession={async (sessionID) => {
          opened.push(sessionID)
          return options.onOpenSession ? options.onOpenSession(sessionID) : undefined
        }}
      />
    ),
    container,
  )
  return {
    container,
    opened,
    summaryCalls,
    rowCalls,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

test("global panel loads once when mounted and never polls", async () => {
  const harness = mount()
  try {
    await flush()
    expect(harness.summaryCalls.length).toBe(1)
    expect(harness.rowCalls.length).toBe(1)
    expect(harness.summaryCalls[0]).toEqual({})
    expect(harness.rowCalls[0]?.source).toBe("steps")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(harness.summaryCalls.length).toBe(1)
    expect(harness.rowCalls.length).toBe(1)
  } finally {
    harness.dispose()
  }
})

test("both ledgers render separately with samples, weighted rate, cost currency and failures", async () => {
  const harness = mount()
  try {
    await flush()
    const stepsCard = harness.container.querySelector('[data-testid="flight-recorder-global-steps"]')!
    const requestsCard = harness.container.querySelector('[data-testid="flight-recorder-global-requests"]')!
    expect(stepsCard.textContent).toContain("3 records")
    expect(stepsCard.textContent).toContain("2 main / 1 sub")
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-steps-hit-rate"]')?.textContent).toBe(
      "90%",
    )
    expect(stepsCard.textContent).toContain("USD booked")
    expect(stepsCard.textContent).toContain("missing 1")
    expect(requestsCard.textContent).toContain("2 records")
    expect(requestsCard.textContent).toContain("failed 1")
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-requests-hit-rate"]')?.textContent).toBe(
      "20%",
    )
    expect(harness.container.textContent).toContain("The two ledgers are aggregated separately")
    expect(harness.container.textContent).toContain("summary scan 5,000 page scan 1,000")
    expect(harness.container.textContent).toContain("server retention 128")
    // 双账本不能混成一张：步骤卡里没有请求失败，请求卡里没有成本。
    expect(stepsCard.textContent).not.toContain("failed 1")
    expect(requestsCard.querySelector('[data-testid="flight-recorder-global-steps-cost"]')).toBeNull()
  } finally {
    harness.dispose()
  }
})

test("partial summary windows and unreported retention are stated honestly", async () => {
  const harness = mount({
    summary: () => summary({ next: "older-window", retention: undefined }),
  })
  try {
    await flush()
    const window = harness.container.querySelector('[data-testid="flight-recorder-global-window"]')!
    expect(window.textContent).toContain("window partial; older rows not examined")
    expect(window.textContent).toContain("retention not reported")
    expect(window.textContent).not.toContain("server retention")
    // 没有服务端策略时不能把 128（每会话默认）或 100000（全局默认）写成当前生效值。
    expect(window.textContent).not.toContain("128")
    expect(window.textContent).not.toContain("100000")
  } finally {
    harness.dispose()
  }
})

test("step detail links to a loaded request, shows unassociated, and never guesses eviction", async () => {
  const linked = { ...row({ id: "linked", requestID: undefined }), requestID: "req_exact" }
  const unlinked = row({ id: "unlinked", requestID: undefined })
  const missing = { ...row({ id: "missing-link", requestID: undefined }), requestID: "req_missing" }
  const target = row({ id: "req_exact", outcome: "failed", requestID: undefined })
  const harness = mount({
    rows: (input) => ({
      items: input.source === "steps" ? [linked, unlinked, missing] : [target],
      scanned: 3,
      truncated: false,
    }),
  })
  try {
    await flush()
    click(harness.container, '[data-row-id="linked"] button')
    await flush()
    let detail = harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')!
    expect(detail.textContent).toContain("req_exact")
    expect(detail.textContent).toContain("linked request")
    expect(detail.textContent).toContain("step total only")
    expect(detail.textContent).not.toContain("unassociated")

    click(harness.container, '[data-testid="flight-recorder-open-request"]')
    await flush()
    await flush()
    // 关联请求在已加载请求行里：切到 requests 并展开它；请求详情不再声称步骤费用。
    detail = harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')!
    expect(detail.getAttribute("data-detail-id")).toBe("req_exact")
    expect(detail.textContent).not.toContain("step total only")
    expect(detail.textContent).not.toContain("linked request")

    click(harness.container, '[data-testid="flight-recorder-global-source-steps"]')
    await flush()
    click(harness.container, '[data-row-id="unlinked"] button')
    await flush()
    detail = harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')!
    expect(detail.textContent).toContain("unassociated")
    expect(harness.container.querySelector('[data-testid="flight-recorder-open-request"]')).toBeNull()

    click(harness.container, '[data-row-id="missing-link"] button')
    await flush()
    click(harness.container, '[data-testid="flight-recorder-open-request"]')
    await flush()
    await flush()
    const note = harness.container.querySelector('[data-testid="flight-recorder-global-request-missing"]')
    expect(note?.textContent).toContain("req_missing")
    expect(note?.textContent).toContain("eviction unknown")
  } finally {
    harness.dispose()
  }
})

test("time range recalculates the window on every request; session filter is exact", async () => {
  const harness = mount()
  try {
    await flush()
    click(harness.container, '[data-testid="flight-recorder-global-range-7d"]')
    await flush()
    const weekFilters = harness.summaryCalls.at(-1)!
    expect(weekFilters.from).toBe(NOW - 7 * 86_400_000)
    expect(weekFilters.to).toBe(NOW + 1)
    expect(harness.rowCalls.at(-1)?.from).toBe(weekFilters.from)

    const input = harness.container.querySelector<HTMLInputElement>('[data-testid="flight-recorder-global-session-input"]')!
    input.value = "ses_exact"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    click(harness.container, '[data-testid="flight-recorder-global-session-apply"]')
    await flush()
    expect(harness.summaryCalls.at(-1)?.sessionID).toBe("ses_exact")
    expect(harness.rowCalls.at(-1)?.sessionID).toBe("ses_exact")
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-scope"]')?.textContent).toContain(
      "session",
    )

    click(harness.container, '[data-testid="flight-recorder-global-clear"]')
    await flush()
    expect(harness.summaryCalls.at(-1)?.sessionID).toBeUndefined()
    expect(harness.summaryCalls.at(-1)?.from).toBeUndefined()
  } finally {
    harness.dispose()
  }
})

test("switching source reloads requests from the same filters and resets the list", async () => {
  const harness = mount({
    rows: (input) => ({
      items: [row({ id: `${input.source}-1`, outcome: input.source === "requests" ? "failed" : "booked" })],
      scanned: 1,
      truncated: false,
    }),
  })
  try {
    await flush()
    expect(harness.container.querySelector('[data-row-id="steps-1"]')).not.toBeNull()
    click(harness.container, '[data-testid="flight-recorder-global-range-24h"]')
    await flush()
    const filters = harness.rowCalls.at(-1)!
    click(harness.container, '[data-testid="flight-recorder-global-source-requests"]')
    await flush()
    expect(harness.rowCalls.at(-1)?.source).toBe("requests")
    expect(harness.rowCalls.at(-1)?.before).toBeUndefined()
    expect(harness.rowCalls.at(-1)?.from).toBe(filters.from)
    expect(harness.container.querySelector('[data-row-id="steps-1"]')).toBeNull()
    expect(harness.container.querySelector('[data-row-id="requests-1"]')).not.toBeNull()
  } finally {
    harness.dispose()
  }
})

test("pagination follows next, keeps a zero-match page cursor, and de-duplicates rows", async () => {
  const first = row({ id: "r1" })
  const second = row({ id: "r2" })
  const third = row({ id: "r3" })
  const harness = mount({
    pageSize: 2,
    rows: (input) => {
      if (!input.before) return { items: [first, second], next: "c1", scanned: 2, truncated: false }
      if (input.before === "c1") return { items: [], next: "c2", scanned: 5, truncated: true }
      return { items: [second, third], scanned: 2, truncated: false }
    },
  })
  try {
    await flush()
    click(harness.container, '[data-testid="flight-recorder-global-load-more"]')
    await flush()
    // 扫描窗口没有匹配行但仍有游标：不能当成“没有更多”。
    expect(
      harness.container.querySelector('[data-testid="flight-recorder-global-rows-empty-page"]')?.textContent,
    ).toContain("empty this scan window")
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-load-more"]')).not.toBeNull()
    click(harness.container, '[data-testid="flight-recorder-global-load-more"]')
    await flush()
    const ids = Array.from(harness.container.querySelectorAll('[data-testid="flight-recorder-global-row"]')).map((item) =>
      item.getAttribute("data-row-id"),
    )
    expect(ids).toEqual(["r1", "r2", "r3"])
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-rows-scanned"]')?.textContent).toContain(
      "scanned 2",
    )
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-rows-end"]')).not.toBeNull()
  } finally {
    harness.dispose()
  }
})

test("client cap reports unloaded rows instead of claiming they were evicted", async () => {
  const harness = mount({
    maxRows: 2,
    rows: () => ({ items: [row({ id: "cap-1" }), row({ id: "cap-2" })], next: "more", scanned: 2, truncated: false }),
  })
  try {
    await flush()
    expect(harness.container.querySelectorAll('[data-testid="flight-recorder-global-row"]').length).toBe(2)
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-load-more"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-rows-cap"]')?.textContent).toContain(
      "client cap 2 not loaded",
    )
  } finally {
    harness.dispose()
  }
})

test("detail exposes session scope, safe jump failure, and narrows to that session", async () => {
  const harness = mount({
    rows: () => ({
      items: [
        row({
          id: "detail-1",
          sessionID: "ses_sub",
          workspaceID: "wrk_feature",
          sub: true,
        }),
      ],
      scanned: 1,
      truncated: false,
    }),
    workspaces: async () => [{ id: "wrk_feature", name: "Feature branch" }],
    onOpenSession: async (sessionID) => {
      if (sessionID === "ses_sub") throw new Error("access denied")
    },
  })
  try {
    await flush()
    expect(
      Array.from(harness.container.querySelectorAll('[data-testid="flight-recorder-global-workspace"]')).some((item) =>
        item.textContent?.includes("Feature branch"),
      ),
    ).toBe(true)
    click(harness.container, '[data-row-id="detail-1"] button')
    await flush()
    const detail = harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')!
    expect(detail.textContent).toContain("ses_sub")
    expect(detail.textContent).toContain("wrk_feature")
    expect(detail.textContent).toContain("subagent session")

    click(harness.container, '[data-testid="flight-recorder-global-open-session"]')
    await flush()
    expect(harness.opened).toEqual(["ses_sub"])
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')?.textContent).toContain(
      "jump failed access denied",
    )

    click(harness.container, '[data-testid="flight-recorder-global-filter-session"]')
    await flush()
    expect(harness.summaryCalls.at(-1)?.sessionID).toBe("ses_sub")
    expect(harness.rowCalls.at(-1)?.sessionID).toBe("ses_sub")
  } finally {
    harness.dispose()
  }
})

test("lowest loaded row reveals its own detail", async () => {
  const harness = mount({
    rows: () => ({
      items: [
        row({ id: "high", cacheRead: 90 }),
        row({ id: "low", cacheRead: 5 }),
        row({ id: "middle", cacheRead: 50 }),
      ],
      scanned: 3,
      truncated: false,
    }),
  })
  const scrolled: string[] = []
  const original = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.getAttribute("data-detail-id") ?? "")
  }
  try {
    await flush()
    click(harness.container, '[data-testid="flight-recorder-global-lowest"]')
    await flush()
    expect(scrolled).toContain("low")
    expect(
      harness.container
        .querySelector('[data-testid="flight-recorder-global-detail"]')
        ?.getAttribute("data-detail-id"),
    ).toBe("low")
  } finally {
    HTMLElement.prototype.scrollIntoView = original
    harness.dispose()
  }
})

test("summary and rows errors retry independently", async () => {
  let summaryAttempt = 0
  let rowsAttempt = 0
  const harness = mount({
    summary: () => {
      summaryAttempt++
      if (summaryAttempt === 1) throw new Error("summary boom")
      return summary()
    },
    rows: () => {
      rowsAttempt++
      if (rowsAttempt === 1) throw new Error("rows boom")
      return { items: [row({ id: "recovered" })], scanned: 1, truncated: false }
    },
  })
  try {
    await flush()
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-summary-error"]')?.textContent).toContain(
      "summary boom",
    )
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-rows-error"]')?.textContent).toContain(
      "rows boom",
    )
    click(harness.container, '[data-testid="flight-recorder-global-summary-retry"]')
    await flush()
    expect(summaryAttempt).toBe(2)
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-summary-error"]')).toBeNull()
    click(harness.container, '[data-testid="flight-recorder-global-rows-retry"]')
    await flush()
    expect(rowsAttempt).toBe(2)
    expect(harness.container.querySelector('[data-row-id="recovered"]')).not.toBeNull()
  } finally {
    harness.dispose()
  }
})

test("hit-rate guard rejects missing and contradictory samples but keeps a real zero", () => {
  expect(flightRecorderGlobalHitRate(undefined)).toBeUndefined()
  expect(
    flightRecorderGlobalHitRate({ input: 100, read: 120, samples: 1, excluded: { invalid: 0, incomplete: 0 } }),
  ).toBeUndefined()
  expect(
    flightRecorderGlobalHitRate({ input: 100, read: 0, samples: 1, excluded: { invalid: 0, incomplete: 0 } }),
  ).toBe(0)
  expect(
    flightRecorderGlobalHitRate({
      input: 100,
      read: 50,
      hitRate: 0.5,
      samples: 1,
      excluded: { invalid: 0, incomplete: 0 },
    }),
  ).toBe(0.5)
})

test("range windows are exclusive at the upper bound and empty for all", () => {
  expect(flightRecorderGlobalWindow("all", NOW)).toEqual({})
  expect(flightRecorderGlobalWindow("24h", NOW)).toEqual({ from: NOW - 86_400_000, to: NOW + 1 })
  expect(flightRecorderGlobalWindow("7d", NOW)).toEqual({ from: NOW - 7 * 86_400_000, to: NOW + 1 })
  expect(flightRecorderGlobalWindow("30d", NOW)).toEqual({ from: NOW - 30 * 86_400_000, to: NOW + 1 })
})

test("lowest ignores rows without a usable ratio", () => {
  const bad = row({ id: "bad", cacheRead: 200, input: 100 })
  const zero = row({ id: "zero", cacheRead: 0, input: 100 })
  const high = row({ id: "high", cacheRead: 90, input: 100 })
  expect(flightRecorderGlobalLowest([bad, high, zero])?.row.id).toBe("zero")
  expect(flightRecorderGlobalLowest([bad])).toBeUndefined()
})

test("empty first page with next still offers continue scanning", async () => {
  let more = 0
  const harness = mount({
    rows: (input) => {
      if (input.before) {
        more++
        return { items: [row({ id: "after-empty" })], scanned: 1, truncated: false }
      }
      return { items: [], next: "cursor-1", scanned: 100, truncated: true }
    },
  })
  try {
    await flush()
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-rows-empty-page"]')).not.toBeNull()
    const button = harness.container.querySelector<HTMLElement>('[data-testid="flight-recorder-global-load-more"]')
    expect(button).not.toBeNull()
    if (!button) return
    button.click()
    await flush()
    expect(more).toBe(1)
    expect(harness.container.querySelector('[data-row-id="after-empty"]')).not.toBeNull()
  } finally {
    harness.dispose()
  }
})

test("model selection keeps the provider instead of filtering by modelID alone", () => {
  const helper = (
    flightRecorderGlobalModule as unknown as {
      flightRecorderGlobalModelFilters?: (model: { providerID: string; modelID: string } | undefined) => {
        providerID?: string
        modelID?: string
      }
    }
  ).flightRecorderGlobalModelFilters
  expect(typeof helper).toBe("function")
  if (!helper) return
  expect(helper({ providerID: "provider-b", modelID: "shared-model" })).toEqual({
    providerID: "provider-b",
    modelID: "shared-model",
  })
  expect(helper(undefined)).toEqual({ providerID: undefined, modelID: undefined })
})

test("provider and model remain filterable when the summary options are unavailable", async () => {
  const harness = mount({
    summary: () => {
      throw new Error("summary down")
    },
  })
  try {
    await flush()
    const provider = harness.container.querySelector<HTMLInputElement>(
      '[data-testid="flight-recorder-global-provider-input"]',
    )
    expect(provider).not.toBeNull()
    if (!provider) return
    provider.value = "manual-provider"
    provider.dispatchEvent(new Event("input", { bubbles: true }))
    click(harness.container, '[data-testid="flight-recorder-global-provider-apply"]')
    await flush()
    expect(harness.summaryCalls.at(-1)?.providerID).toBe("manual-provider")

    const model = harness.container.querySelector<HTMLInputElement>(
      '[data-testid="flight-recorder-global-model-input"]',
    )
    expect(model).not.toBeNull()
    if (!model) return
    model.value = "manual-model"
    model.dispatchEvent(new Event("input", { bubbles: true }))
    click(harness.container, '[data-testid="flight-recorder-global-model-apply"]')
    await flush()
    expect(harness.summaryCalls.at(-1)?.modelID).toBe("manual-model")
  } finally {
    harness.dispose()
  }
})

test("workspace list failure is visible and a manual workspace still works", async () => {
  const harness = mount({
    workspaces: async () => {
      throw new Error("workspace boom")
    },
  })
  try {
    await flush()
    const failure = harness.container.querySelector('[data-testid="flight-recorder-global-workspaces-error"]')
    expect(failure?.textContent).toContain("workspace boom")
    expect(harness.container.querySelector('[data-testid="flight-recorder-global-workspaces-retry"]')).not.toBeNull()

    const input = harness.container.querySelector<HTMLInputElement>(
      '[data-testid="flight-recorder-global-workspace-input"]',
    )
    expect(input).not.toBeNull()
    if (!input) return
    input.value = "wrk_manual"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    click(harness.container, '[data-testid="flight-recorder-global-workspace-apply"]')
    await flush()
    expect(harness.rowCalls.at(-1)?.workspaceID).toBe("wrk_manual")
  } finally {
    harness.dispose()
  }
})

test("request search stops on a load error and exposes retry", async () => {
  const linked = { ...row({ id: "step-link" }), requestID: "req_retry" }
  const target = row({ id: "req_retry", outcome: "failed" })
  let more = 0
  const harness = mount({
    rows: (input) => {
      if (input.source === "steps") return { items: [linked], scanned: 1, truncated: false }
      if (!input.before) return { items: [row({ id: "req_other" })], next: "c1", scanned: 1, truncated: false }
      more++
      if (more === 1) throw new Error("network down")
      return { items: [target], scanned: 1, truncated: false }
    },
  })
  try {
    await flush()
    click(harness.container, '[data-row-id="step-link"] button')
    await flush()
    click(harness.container, '[data-testid="flight-recorder-open-request"]')
    await flush()
    await flush()
    // 第一次分页失败后必须停下；旧实现会保留 next 自动重试，直到把请求找出来。
    expect(more).toBe(1)
    const error = harness.container.querySelector('[data-testid="flight-recorder-global-request-error"]')
    expect(error?.textContent).toContain("network down")
    expect(
      harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')?.getAttribute("data-detail-id"),
    ).not.toBe("req_retry")

    click(harness.container, '[data-testid="flight-recorder-global-request-retry"]')
    await flush()
    await flush()
    expect(more).toBe(2)
    expect(
      harness.container.querySelector('[data-testid="flight-recorder-global-detail"]')?.getAttribute("data-detail-id"),
    ).toBe("req_retry")
  } finally {
    harness.dispose()
  }
})

test("scope never claims all workspaces when the server may be workspace-scoped", async () => {
  const harness = mount()
  try {
    await flush()
    const scope = harness.container.querySelector('[data-testid="flight-recorder-global-scope"]')!
    expect(scope.textContent).not.toContain("all workspaces")
    expect(scope.textContent).toContain("server workspace scope")
    expect(scope.textContent).toContain("workspace scope is not universal")
  } finally {
    harness.dispose()
  }
})

// 类型锚：保证面板接受的 loader 形状与生成 SDK 契约保持一致。
const _row: FlightRecorderRow = row()
const _page: FlightRecorderGlobalPage = { items: [], scanned: 0, truncated: false }
void _row
void _page
