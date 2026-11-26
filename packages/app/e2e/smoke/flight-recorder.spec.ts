import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import type { FlightRecorderRow } from "@redcode-ai/sdk/v2/client"
import { trackPageErrors } from "../utils/errors"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline.fixture"

// 261126 Red Flight Recorder 浏览器验收：现有 Context 入口懒加载、steps/requests
// 切换、32.1% 低点详情的前缀证据、旧账翻页。全部走离线 mock，不碰真实库或模型。

const stepPage1: FlightRecorderRow[] = [
  {
    id: "step-1",
    messageID: "msg_step_1",
    time: 1700000100000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "booked",
    summary: true,
    input: 1000,
    output: 240,
    cacheRead: 640,
    cacheWrite: 0,
    cacheMiss: 360,
    cost: 0.12,
    currency: "CNY",
  },
  {
    id: "step-2",
    messageID: "msg_step_2",
    time: 1700000090000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "booked",
    input: 1000,
    output: 180,
    cacheRead: 320,
    cacheWrite: 0,
    cacheMiss: 680,
    cost: 0.1,
    currency: "CNY",
  },
]

const stepPage2: FlightRecorderRow[] = [
  {
    id: "step-3",
    messageID: "msg_step_3",
    time: 1700000080000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "booked",
    input: 1000,
    output: 160,
    cacheRead: 300,
    cacheWrite: 0,
    cacheMiss: 700,
    cost: 0.09,
    currency: "CNY",
  },
  {
    id: "step-4",
    messageID: "msg_step_4",
    time: 1700000070000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "booked",
    input: 1000,
    output: 140,
    cacheRead: 200,
    cacheWrite: 0,
    cacheMiss: 800,
    cost: 0.08,
    currency: "CNY",
  },
]

const requestRows: FlightRecorderRow[] = [
  {
    id: "req-low",
    messageID: "msg_req_low",
    time: 1700000200000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "completed",
    input: 1000,
    output: 42,
    cacheRead: 321,
    cacheWrite: 100,
    cacheMiss: 679,
    durationMs: 2_500,
    firstEventMs: 450,
    prefix: { system: "baseline", tools: "append", history: "rewind", compressed: true },
  },
  {
    id: "req-high",
    messageID: "msg_req_high",
    time: 1700000190000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "completed",
    input: 1000,
    output: 56,
    cacheRead: 900,
    cacheWrite: 50,
    cacheMiss: 100,
    durationMs: 1_800,
    firstEventMs: 320,
    prefix: { system: "unchanged", tools: "unchanged", history: "unchanged", compressed: false },
  },
  {
    id: "req-mid",
    messageID: "msg_req_mid",
    time: 1700000180000,
    providerID: "redcode",
    modelID: "claude-opus-4-6",
    outcome: "completed",
    input: 1000,
    output: 30,
    cacheRead: 500,
    cacheWrite: 0,
    cacheMiss: 500,
    durationMs: 2_100,
    firstEventMs: 400,
  },
]

type RecorderCall = { sessionID: string; source: string; before?: string }

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

async function openSession(page: Page) {
  await page.goto("/")
  await page
    .locator('[data-component="home-project-row"]')
    .filter({ hasText: new RegExp(fixture.project.name, "i") })
    .click()
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible()
  await page.locator('[data-system-tab="context"]').click()
  await expect(page.getByTestId("flight-recorder-toggle")).toBeVisible()
}

test.describe("smoke: flight recorder", () => {
  test.setTimeout(120_000)

  test("context entry stays lazy, both sources load, low point reveals prefix, history pages", async ({ page }) => {
    const errors = trackPageErrors(page)
    const calls: RecorderCall[] = []
    await mockRedCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      flightRecorder: (sessionID, source, before) => {
        calls.push({ sessionID, source, before })
        if (source === "requests") return { items: requestRows }
        if (!before) return { items: stepPage1, next: "steps-cursor-2" }
        if (before === "steps-cursor-2") return { items: stepPage2 }
        return { items: [] }
      },
    })
    await configureSmokePage(page, fixture.directory)
    await openSession(page)

    // 入口默认折叠：Context tab 已打开并渲染入口，但不能发 flight-recorder 请求。
    await page.waitForTimeout(500)
    expect(calls).toHaveLength(0)

    await page.getByTestId("flight-recorder-toggle").click()
    const panel = page.getByTestId("flight-recorder-panel")
    await expect(panel).toBeVisible()
    await expect(page.getByTestId("flight-recorder-row")).toHaveCount(stepPage1.length)
    expect(calls).toEqual([{ sessionID: fixture.sourceID, source: "steps", before: undefined }])

    // 新来源：实际请求。低点 32.1%，点击后详情和前缀证据必须滚进视口。
    await page.getByTestId("flight-recorder-source-requests").click()
    await expect(page.getByTestId("flight-recorder-row")).toHaveCount(requestRows.length)
    expect(calls.at(-1)).toEqual({ sessionID: fixture.sourceID, source: "requests", before: undefined })
    const lowPoint = page.getByTestId("flight-recorder-low-point")
    await expect(lowPoint).toContainText("32.1%")
    await lowPoint.click()
    const lowDetail = page.locator('[data-testid="flight-recorder-detail"][data-detail-id="req-low"]')
    await expect(lowDetail).toBeVisible()
    await expect(lowDetail).toBeInViewport()
    await expect(lowDetail).toContainText("msg_req_low")
    await expect(page.getByTestId("flight-recorder-prefix")).toBeVisible()

    // 旧来源：账单步骤。切回后首次请求重置分页，手动加载下一页。
    await page.getByTestId("flight-recorder-source-steps").click()
    await expect(page.getByTestId("flight-recorder-row")).toHaveCount(stepPage1.length)
    const beforeLoadMore = calls.length
    await page.getByTestId("flight-recorder-load-more").click()
    await expect.poll(() => calls.length).toBe(beforeLoadMore + 1)
    expect(calls.at(-1)).toEqual({
      sessionID: fixture.sourceID,
      source: "steps",
      before: "steps-cursor-2",
    })
    await expect(page.locator('[data-row-id="step-3"]')).toBeVisible()
    await expect(page.getByTestId("flight-recorder-row")).toHaveCount(stepPage1.length + stepPage2.length)

    expect(errors).toEqual([])
  })
})
