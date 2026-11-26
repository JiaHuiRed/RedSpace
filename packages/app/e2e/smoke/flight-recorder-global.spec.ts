import { expect, test, type Page } from "@playwright/test"
import type { FlightRecorderRow } from "@redcode-ai/sdk/v2/client"
import { trackPageErrors } from "../utils/errors"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline.fixture"

// 261126 Red FR-04 全局入口的浏览器验收：首页入口懒加载、作用域不冒充跨项目、双账本
// 分开、窗口/retention 来自服务端、筛选与游标真的送到服务端、详情与安全跳转按钮。
// 全部走离线 mock，不碰真实库或模型。

const stepRows: FlightRecorderRow[] = [
  {
    id: "global-step-1",
    messageID: "msg_global_step_1",
    time: 1700000100000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "booked",
    input: 1000,
    output: 240,
    cacheRead: 640,
    cost: 0.2,
    currency: "USD",
  },
  {
    id: "global-step-2",
    messageID: "msg_global_step_2",
    time: 1700000090000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "booked",
    input: 1000,
    output: 180,
    cacheRead: 320,
    cost: 0.22,
    currency: "USD",
  },
]

const stepRowOlder: FlightRecorderRow = {
  id: "global-step-3",
  messageID: "msg_global_step_3",
  time: 1700000080000,
  providerID: "redcode",
  modelID: "claude-opus-4-6",
  outcome: "booked",
  input: 500,
  output: 90,
  cacheRead: 100,
  cost: 0.1,
  currency: "USD",
}

const requestRows: FlightRecorderRow[] = [
  {
    id: "global-request-1",
    messageID: "msg_global_request_1",
    time: 1700000200000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "failed",
    input: 1000,
    cacheRead: 100,
    durationMs: 2400,
    firstEventMs: 400,
  },
]

const globalRow = (row: FlightRecorderRow, overrides: Record<string, unknown> = {}) => ({
  ...row,
  sessionID: fixture.sourceID,
  sub: false,
  ...overrides,
})

const usage = (overrides: Record<string, unknown> = {}) => ({
  samples: 3,
  input: 3000,
  output: 510,
  cacheRead: 1060,
  cacheWrite: 0,
  cacheMiss: 1940,
  cache: { input: 3000, read: 1060, samples: 3, excluded: { invalid: 0, incomplete: 0 } },
  ...overrides,
})

const summary = {
  steps: {
    samples: 4,
    sessions: { main: 2, sub: 1 },
    usage: usage(),
    outcomes: { booked: 4, estimated: 0 },
    cost: [{ currency: "USD", booked: 0.42, estimated: 0.05, samples: 3, missing: 1 }],
  },
  requests: {
    samples: 3,
    sessions: { main: 1, sub: 1 },
    usage: usage({ samples: 3, input: 2500, output: 300, cacheRead: 500, cache: { input: 2500, read: 500, samples: 3, excluded: { invalid: 0, incomplete: 0 } } }),
    outcomes: { completed: 1, failed: 1, cancelled: 1, unknown: 0 },
    latency: {
      samples: 2,
      durationMs: { p50: 1200, p95: 2400, max: 2600 },
      firstEventMs: { p50: 300, p95: 400, max: 500 },
    },
  },
  ownership: {
    steps: { main: usage({ samples: 3 }), sub: usage({ samples: 1 }) },
    requests: { main: usage({ samples: 2 }), sub: usage({ samples: 1 }) },
  },
  models: [{ providerID: "redcode", modelID: "claude-opus-4-6", steps: { samples: 4, sessions: { main: 2, sub: 1 }, usage: usage(), outcomes: { booked: 4, estimated: 0 }, cost: [] }, requests: { samples: 3, sessions: { main: 1, sub: 1 }, usage: usage(), outcomes: { completed: 1, failed: 1, cancelled: 1, unknown: 0 }, latency: { samples: 0, durationMs: {}, firstEventMs: {} } } }],
  workspaces: [{ workspaceID: null, steps: { samples: 4, sessions: { main: 2, sub: 1 }, usage: usage(), outcomes: { booked: 4, estimated: 0 }, cost: [] }, requests: { samples: 3, sessions: { main: 1, sub: 1 }, usage: usage(), outcomes: { completed: 1, failed: 1, cancelled: 1, unknown: 0 }, latency: { samples: 0, durationMs: {}, firstEventMs: {} } } }],
  daily: [],
  coverage: {
    steps: { from: 1700000080000, to: 1700000100000, scanned: 5, truncated: false },
    requests: { from: 1700000200000, to: 1700000200000, scanned: 4, truncated: false },
  },
  truncated: false,
  // 服务端明确说明还有更旧窗口：界面必须显示“只覆盖最新扫描窗口”，不能当成完整历史。
  next: "summary-older",
  breakdownsTruncated: false,
  limits: { scan: 5000, pageScan: 1000, groups: 50, trendDays: 60 },
  // 故意用非 128 的值验证界面只认服务端报告，不把默认 128/100000 写成当前生效值。
  retention: { requestsPerSession: 640 },
}

type Call = { kind: "summary" | "rows"; query: URLSearchParams }

async function configureSmokePage(page: Page, directory: string) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
          showSessionProgressBar: true,
        },
      }),
    )
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "RedCode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)
}

test.describe("smoke: global flight recorder", () => {
  test.setTimeout(120_000)

  test("home entry stays lazy, queries the server window policy, filters and pages rows", async ({ page }) => {
    const errors = trackPageErrors(page)
    const calls: Call[] = []
    await mockRedCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      flightRecorderSummary: (query) => {
        calls.push({ kind: "summary", query: new URLSearchParams(query) })
        return summary
      },
      flightRecorderRows: (query) => {
        calls.push({ kind: "rows", query: new URLSearchParams(query) })
        if (query.get("source") === "requests") return { items: requestRows.map((row) => globalRow(row)), scanned: 1, truncated: false }
        if (!query.get("before")) {
          return {
            items: [
              globalRow(stepRows[0]!, { requestID: "req_exact" }),
              globalRow(stepRows[1]!),
            ],
            next: "rows-older",
            scanned: 2,
            truncated: false,
          }
        }
        return { items: [globalRow(stepRowOlder)], scanned: 1, truncated: false }
      },
    })
    await configureSmokePage(page, fixture.directory)
    await page.goto("/")
    const entry = page.getByTestId("home-flight-recorder-open")
    await expect(entry).toBeVisible()

    // 入口未点开前不发任何全局查询。
    await page.waitForTimeout(500)
    expect(calls).toHaveLength(0)

    await entry.click()
    await expect(page.getByTestId("flight-recorder-global-panel")).toBeVisible()
    await expect.poll(() => calls.filter((call) => call.kind === "summary").length).toBe(1)
    await expect.poll(() => calls.filter((call) => call.kind === "rows").length).toBe(1)
    expect(calls[0]?.query.get("directory")).toBe(fixture.directory)

    const scope = page.getByTestId("flight-recorder-global-scope")
    await expect(scope).toContainText("smoke-project")
    await expect(scope).toContainText("no workspace filter")
    await expect(scope).not.toContainText("all workspaces")
    await expect(scope).toContainText("does not mean every workspace")

    const stepsCard = page.getByTestId("flight-recorder-global-steps")
    const requestsCard = page.getByTestId("flight-recorder-global-requests")
    await expect(stepsCard).toContainText("4 records")
    await expect(stepsCard).toContainText("USD")
    await expect(requestsCard).toContainText("failed 1")
    const window = page.getByTestId("flight-recorder-global-window")
    await expect(window).toContainText("Each summary ledger scans at most 5,000 index rows; each rows page at most 1,000.")
    await expect(window).toContainText("retention: at most 640")
    await expect(window).toContainText("newest scanned window")
    await expect(window).not.toContainText("128")

    // 步骤详情：精确关联 ID 与未关联必须分开；费用说明只属于步骤总额。
    await expect(page.getByTestId("flight-recorder-global-row")).toHaveCount(2)
    await page.locator('[data-row-id="global-step-1"] button').first().click()
    const detail = page.locator('[data-testid="flight-recorder-global-detail"][data-detail-id="global-step-1"]')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText("req_exact")
    await expect(detail).toContainText("Cost is this step's total")
    await page.locator('[data-row-id="global-step-2"] button').first().click()
    await expect(detail).not.toBeVisible()
    await expect(
      page.locator('[data-testid="flight-recorder-global-detail"][data-detail-id="global-step-2"]'),
    ).toContainText("unassociated")

    // 会话筛选与时间范围都走服务端 query，不在客户端遍历会话。
    await page.getByTestId("flight-recorder-global-filter-session").click()
    await expect.poll(() => calls.at(-1)?.query.get("sessionID")).toBe(fixture.sourceID)
    await page.getByTestId("flight-recorder-global-range-7d").click()
    await expect.poll(() => calls.at(-1)?.query.get("from")).not.toBeNull()
    await expect.poll(() => calls.at(-1)?.query.get("sessionID")).toBe(fixture.sourceID)

    // 清除会话筛选后翻页，游标原样送回服务端。
    await page.getByTestId("flight-recorder-global-clear").click()
    await expect.poll(() => calls.at(-1)?.query.get("sessionID")).toBeNull()
    await page.getByTestId("flight-recorder-global-load-more").click()
    await expect.poll(() => calls.at(-1)?.query.get("before")).toBe("rows-older")
    await expect(page.locator('[data-row-id="global-step-3"]')).toBeVisible()
    await expect(page.getByTestId("flight-recorder-global-rows-end")).toBeVisible()

    // 不轮询：静置后查询次数不再增长；关闭后也不再发。
    const settled = calls.length
    await page.waitForTimeout(700)
    expect(calls.length).toBe(settled)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("flight-recorder-global-panel")).toBeHidden()
    await page.waitForTimeout(300)
    expect(calls.length).toBe(settled)

    expect(errors).toEqual([])
  })

  test("empty first page with a cursor can continue scanning", async ({ page }) => {
    const rowsCalls: URLSearchParams[] = []
    await mockRedCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      flightRecorderSummary: () => summary,
      flightRecorderRows: (query) => {
        rowsCalls.push(new URLSearchParams(query))
        if (query.get("source") !== "steps") return { items: [], scanned: 0, truncated: false }
        if (!query.get("before")) return { items: [], next: "empty-cursor", scanned: 5000, truncated: true }
        return { items: [globalRow(stepRowOlder)], scanned: 1, truncated: false }
      },
    })
    await configureSmokePage(page, fixture.directory)
    await page.goto("/")
    await page.getByTestId("home-flight-recorder-open").click()
    await expect(page.getByTestId("flight-recorder-global-rows-empty-page")).toBeVisible()
    const loadMore = page.getByTestId("flight-recorder-global-load-more")
    await expect(loadMore).toBeVisible()
    await loadMore.click()
    await expect(page.locator('[data-row-id="global-step-3"]')).toBeVisible()
    expect(rowsCalls.at(-1)?.get("before")).toBe("empty-cursor")
  })

  test("failed linked-request search stops and retries without a request storm", async ({ page }) => {
    let olderAttempts = 0
    const linked = { ...stepRows[0]!, requestID: "req_retry" }
    const target: FlightRecorderRow = {
      ...stepRows[2]!,
      id: "req_retry",
      messageID: "msg_req_retry",
      outcome: "failed",
    }
    await mockRedCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      flightRecorderSummary: () => summary,
      flightRecorderRows: (query) => {
        if (query.get("source") === "steps") return { items: [globalRow(linked)], scanned: 1, truncated: false }
        if (!query.get("before")) {
          return { items: [globalRow(requestRows[0]!, { id: "req_other" })], next: "req-cursor", scanned: 1, truncated: false }
        }
        olderAttempts++
        if (olderAttempts === 1) throw new Error("rows network down")
        return { items: [globalRow(target)], scanned: 1, truncated: false }
      },
    })
    await configureSmokePage(page, fixture.directory)
    await page.goto("/")
    await page.getByTestId("home-flight-recorder-open").click()
    await page.locator('[data-row-id="global-step-1"] button').first().click()
    await page.getByTestId("flight-recorder-open-request").click()
    await expect(page.getByTestId("flight-recorder-global-request-error")).toContainText(
      "Could not finish searching for the linked request",
    )
    expect(olderAttempts).toBe(1)
    await page.waitForTimeout(500)
    expect(olderAttempts).toBe(1)
    await page.getByTestId("flight-recorder-global-request-retry").click()
    await expect(
      page.locator('[data-testid="flight-recorder-global-detail"][data-detail-id="req_retry"]'),
    ).toBeVisible()
    expect(olderAttempts).toBe(2)
  })

})
