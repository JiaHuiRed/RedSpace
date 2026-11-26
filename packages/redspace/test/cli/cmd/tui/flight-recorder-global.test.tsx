/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { CacheStats, GlobalPage, GlobalRow, GlobalSummary, UsageStats } from "@/session/flight-recorder"
import { onCleanup, onMount, type JSX } from "solid-js"
import {
  DialogFlightRecorderGlobal,
  FLIGHT_RECORDER_GLOBAL_COMMAND,
  formatRetentionPolicy,
  flightRecorderTimeBounds,
  formatGlobalCost,
  formatGlobalCoverage,
  formatGlobalHitRate,
  mergeFlightRecorderGlobalRows,
  type FlightRecorderGlobalLoad,
} from "../../../../src/cli/cmd/tui/feature-plugins/flight-recorder"
import globalPlugin from "../../../../src/cli/cmd/tui/feature-plugins/flight-recorder"
import { CommandPaletteDialog } from "../../../../src/cli/cmd/tui/component/command-palette"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { context as ThemeContext } from "../../../../src/cli/cmd/tui/context/theme"
import { DialogProvider, useDialog } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"

const color = RGBA.fromHex("#eeeeee")
const theme = {
  text: color,
  textMuted: color,
  primary: color,
  accent: color,
  secondary: color,
  error: color,
  warning: color,
  success: color,
  border: color,
  borderSubtle: color,
  borderActive: color,
  background: color,
  backgroundPanel: color,
  backgroundElement: color,
  backgroundMessage: color,
  selectedListItemText: color,
}

const FIXED_NOW = new Date(2026, 10, 26, 12, 0, 0).getTime()

function usageStats(patch: Partial<UsageStats> = {}): UsageStats {
  return {
    samples: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheMiss: 0,
    cache: { input: 0, read: 0, samples: 0, excluded: { invalid: 0, incomplete: 0 } },
    ...patch,
  }
}

function cacheStats(hitRate: number, patch: Partial<CacheStats> = {}): CacheStats {
  return {
    input: 1000,
    read: Math.round(hitRate * 1000),
    samples: 1,
    hitRate,
    excluded: { invalid: 1, incomplete: 1 },
    ...patch,
  }
}

function stepSummary(patch: Partial<GlobalSummary["steps"]> = {}): GlobalSummary["steps"] {
  return {
    samples: 0,
    sessions: { main: 0, sub: 0 },
    usage: usageStats(),
    outcomes: { booked: 0, estimated: 0 },
    cost: [],
    ...patch,
  }
}

function requestSummary(patch: Partial<GlobalSummary["requests"]> = {}): GlobalSummary["requests"] {
  return {
    samples: 0,
    sessions: { main: 0, sub: 0 },
    usage: usageStats(),
    outcomes: { completed: 0, failed: 0, cancelled: 0, unknown: 0 },
    latency: { samples: 0, durationMs: {}, firstEventMs: {} },
    ...patch,
  }
}

function globalSummary(patch: Partial<GlobalSummary> = {}): GlobalSummary {
  return {
    steps: stepSummary(),
    requests: requestSummary(),
    ownership: {
      steps: { main: usageStats(), sub: usageStats() },
      requests: { main: usageStats(), sub: usageStats() },
    },
    models: [],
    workspaces: [],
    daily: [],
    coverage: {
      steps: { scanned: 0, truncated: false },
      requests: { scanned: 0, truncated: false },
    },
    truncated: false,
    breakdownsTruncated: false,
    limits: { scan: 1000, groups: 50, trendDays: 60 },
    retention: { requestsPerSession: 128 },
    ...patch,
  }
}

function globalRow(patch: Partial<GlobalRow> = {}): GlobalRow {
  return {
    id: "row_1",
    messageID: "msg_1",
    time: 1_700_000_000_000,
    providerID: "openai",
    modelID: "click-model",
    outcome: "completed",
    sessionID: "ses_alpha",
    sub: false,
    ...patch,
  }
}

// 步骤账的 requestID 是后端 schema 的字段；全局列表原样展示，缺失即未关联。
function globalStepRow(requestID: string, patch: Partial<GlobalRow> = {}): GlobalRow {
  return globalRow({ outcome: "booked", ...patch, requestID })
}

function globalPage(items: GlobalRow[], patch: Partial<GlobalPage> = {}): GlobalPage {
  return { items, scanned: items.length, truncated: false, ...patch }
}

const richSteps = stepSummary({
  samples: 2,
  sessions: { main: 1, sub: 1 },
  usage: usageStats({
    samples: 2,
    input: 1000,
    output: 200,
    cacheRead: 650,
    cacheWrite: 100,
    cacheMiss: 350,
    cache: cacheStats(0.65),
  }),
  outcomes: { booked: 1, estimated: 1 },
  cost: [{ currency: "USD", booked: 0.25, estimated: 0.1, samples: 2, missing: 1 }],
})

const richRequests = requestSummary({
  samples: 3,
  sessions: { main: 1, sub: 1 },
  usage: usageStats({
    samples: 3,
    input: 500,
    output: 60,
    cacheRead: 200,
    cacheWrite: 0,
    cacheMiss: 300,
    cache: cacheStats(0.4, { input: 500, read: 200, excluded: { invalid: 0, incomplete: 2 } }),
  }),
  outcomes: { completed: 2, failed: 1, cancelled: 0, unknown: 0 },
  latency: { samples: 2, durationMs: { p50: 1200, p95: 4000, max: 8000 }, firstEventMs: { p50: 300 } },
})

const richSummary = globalSummary({
  steps: richSteps,
  requests: richRequests,
  ownership: {
    steps: { main: usageStats({ input: 800 }), sub: usageStats({ input: 200 }) },
    requests: { main: usageStats({ input: 400 }), sub: usageStats({ input: 100 }) },
  },
  models: [{ providerID: "openai", modelID: "gpt-test", steps: richSteps, requests: richRequests }],
  workspaces: [
    { workspaceID: "ws_alpha", steps: richSteps, requests: richRequests },
    { steps: stepSummary(), requests: requestSummary() },
  ],
  daily: [
    { day: "2026-11-25", steps: stepSummary(), requests: requestSummary() },
    { day: "2026-11-26", steps: richSteps, requests: richRequests },
  ],
  coverage: {
    steps: { from: 1_700_000_000_000, to: 1_700_000_100_000, scanned: 40, truncated: false },
    requests: { from: 1_700_000_000_000, to: 1_700_000_100_000, scanned: 1000, truncated: true },
  },
  truncated: true,
  breakdownsTruncated: true,
  retention: { requestsPerSession: 128, totalRequests: 100_000 },
})

// 分页用例只需要一个短摘要，保证记录区在首屏可见。
const quietSummary = globalSummary({ steps: stepSummary({ samples: 1 }) })

type NavigateCall = { name: string; params?: Record<string, unknown> }

function Harness(props: {
  client: TuiPluginApi["client"]
  onNavigate: (name: string, params?: Record<string, unknown>) => void
  onKeymap?: (keymap: ReturnType<typeof createDefaultOpenTuiKeymap>) => void
  children: (api: TuiPluginApi) => JSX.Element
}) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createTuiResolvedConfig()
  props.onKeymap?.(keymap)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={config}>
        <ThemeContext.Provider value={{ theme } as never}>
          <ToastProvider>
            <DialogProvider>
              <Bridge keymap={keymap} config={config} client={props.client} onNavigate={props.onNavigate}>
                {props.children}
              </Bridge>
            </DialogProvider>
          </ToastProvider>
        </ThemeContext.Provider>
      </TuiConfigProvider>
    </OpencodeKeymapProvider>
  )
}

function Bridge(props: {
  keymap: ReturnType<typeof createDefaultOpenTuiKeymap>
  config: ReturnType<typeof createTuiResolvedConfig>
  client: TuiPluginApi["client"]
  onNavigate: (name: string, params?: Record<string, unknown>) => void
  children: (api: TuiPluginApi) => JSX.Element
}) {
  const dialog = useDialog()
  const api = {
    app: { version: "test" },
    theme: { current: theme },
    ui: { dialog, toast: () => {} },
    tuiConfig: props.config,
    keymap: props.keymap,
    state: {
      path: { state: "", config: "", worktree: "D:/work", directory: "D:/work/redcode" },
      vcs: undefined,
    },
    route: { navigate: props.onNavigate, current: { name: "home" } },
    client: props.client,
  } as unknown as TuiPluginApi
  return props.children(api)
}

// 以命令面板的方式加载内建插件；palette 命令与 app.tsx 的真实接线同形。
function PluginHost(props: { api: TuiPluginApi }) {
  onMount(() => {
    void globalPlugin.tui(props.api, undefined, {} as never)
    props.api.keymap.registerLayer({
      commands: [
        {
          name: "command.palette.show",
          title: "Show command palette",
          hidden: true,
          run() {
            props.api.ui.dialog.replace(() => <CommandPaletteDialog />)
          },
        },
      ],
      bindings: [{ key: "ctrl+p", cmd: "command.palette.show", desc: "Commands", group: "App" }],
    })
  })
  return <box />
}

function fakeClient(handler: (url: string, query: Record<string, unknown>) => unknown) {
  const calls: { url: string; query: Record<string, unknown> }[] = []
  const record = (url: string, query: Record<string, unknown>) => {
    calls.push({ url, query })
    return { data: handler(url, query) }
  }
  const client = {
    session: {
      flightRecorderSummary: async (query: Record<string, unknown>) =>
        record("/session/flight-recorder/summary", query),
      flightRecorderRows: async (query: Record<string, unknown>) => record("/session/flight-recorder/rows", query),
    },
  } as unknown as TuiPluginApi["client"]
  return { client, calls }
}

async function mount(
  props: {
    client: TuiPluginApi["client"]
    children: (api: TuiPluginApi) => JSX.Element
  },
  options: { width?: number; height?: number } = {},
) {
  const navigateCalls: NavigateCall[] = []
  let keymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined
  const app = await testRender(
    () => (
      <Harness
        client={props.client}
        onNavigate={(name, params) => navigateCalls.push({ name, params })}
        onKeymap={(value) => {
          keymap = value
        }}
      >
        {props.children}
      </Harness>
    ),
    { width: options.width ?? 120, height: options.height ?? 110, kittyKeyboard: true },
  )
  const paint = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Flight recorder condition timed out:\n${await paint()}`)
      await Bun.sleep(20)
      await paint()
    }
    return paint()
  }
  const clickRow = async (text: string) => {
    const frame = await paint()
    const y = frame.split("\n").findIndex((line) => line.includes(text))
    if (y < 0) throw new Error(`row not found: ${text}\n${frame}`)
    await app.mockMouse.pressDown(35, y)
    await paint()
    await app.mockMouse.release(35, y)
    return y
  }
  return { app, paint, until, clickRow, navigateCalls, keymap: () => keymap! }
}

// 261126 Red FR-04：命令面板在会话外就能发现全局入口；完整按下/释放不会把新弹窗关掉，也不轮询。
test("global entry is discoverable from the palette and survives a full click without polling", async () => {
  const { client, calls } = fakeClient((url) =>
    url.endsWith("/summary")
      ? globalSummary({ steps: stepSummary({ samples: 1 }), requests: requestSummary({ samples: 1 }) })
      : globalPage([
          globalStepRow("req_global", {
            modelID: "click-model",
            cost: 0.25,
            currency: "USD",
            input: 100,
            cacheRead: 20,
          }),
        ]),
  )
  const modal = await mount({ client, children: (api) => <PluginHost api={api} /> })
  try {
    expect(await modal.paint()).not.toContain("执行历史 · 全局")
    expect(calls).toHaveLength(0)

    const entries = modal.keymap().getCommandEntries({ namespace: "palette", visibility: "reachable" })
    expect(entries.some((entry) => entry.command.name === FLIGHT_RECORDER_GLOBAL_COMMAND)).toBe(true)

    modal.app.mockInput.pressKey("p", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("Commands"))
    await modal.until(() => modal.app.renderer.currentFocusedEditor !== null)
    await modal.app.mockInput.typeText("global")
    const palette = await modal.until(() => modal.app.captureCharFrame().includes("Open global execution history"))
    expect(palette).toContain("Open global execution history")

    const paletteRow = palette.split("\n").findIndex((line) => line.includes("Open global execution history"))
    await modal.app.mockMouse.pressDown(60, paletteRow)
    await modal.paint()
    await modal.app.mockMouse.release(60, paletteRow)
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("执行历史 · 全局"))
    expect(frame).toContain("当前服务器项目/工作区")
    expect(calls.map((call) => call.url)).toEqual([
      "/session/flight-recorder/summary",
      "/session/flight-recorder/rows",
    ])
    expect(calls[0]!.query).toEqual({})
    expect(calls[1]!.query).toEqual({ source: "steps", limit: 30 })

    // 懒加载：打开后不会自己轮询。
    const loaded = calls.length
    await Bun.sleep(60)
    await modal.paint()
    expect(calls.length).toBe(loaded)
  } finally {
    modal.app.renderer.destroy()
  }
})

// 不经过命令面板直接打开时，完整点击与按键都应留在弹窗内：
// 步骤账显示服务端投影的 requestID 和“步骤总费用”口径，请求账再走会话跳转。
test("global command opens the dialog and keeps clicks, detail and session jump inside it", async () => {
  const { client } = fakeClient((url) =>
    url.endsWith("/summary")
      ? globalSummary({ steps: stepSummary({ samples: 1 }), requests: requestSummary({ samples: 1 }) })
      : globalPage([
          globalStepRow("req_global", {
            modelID: "click-model",
            cost: 0.25,
            currency: "USD",
            input: 100,
            cacheRead: 20,
          }),
        ]),
  )
  const modal = await mount({ client, children: (api) => <PluginHost api={api} /> })
  try {
    modal.keymap().dispatchCommand(FLIGHT_RECORDER_GLOBAL_COMMAND)
    await modal.until(() => modal.app.captureCharFrame().includes("执行历史 · 全局"))
    await modal.until(() => modal.app.captureCharFrame().includes("click-model"))
    await modal.clickRow("click-model")
    const detail = await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))
    expect(detail).toContain("会话 ses_alpha")
    expect(detail).toContain("主会话")
    expect(detail).toContain("请求关联 req_global")
    expect(detail).toContain("费用口径 步骤总费用")
    expect(detail).toContain("不拆分到单次请求")

    modal.app.mockInput.pressArrow("left")
    await modal.until(() => modal.app.captureCharFrame().includes("来源 · 账单步骤"))
    await modal.clickRow("来源 · 账单步骤")
    await modal.until(() => modal.app.captureCharFrame().includes("来源 · 请求尝试"))

    await modal.clickRow("click-model")
    const requestDetail = await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))
    expect(requestDetail).toContain("会话 ses_alpha")
    modal.app.mockInput.pressEnter()
    await modal.until(() => !modal.app.captureCharFrame().includes("执行记录详情"))
    expect(modal.navigateCalls).toEqual([{ name: "session", params: { sessionID: "ses_alpha" } }])
  } finally {
    modal.app.renderer.destroy()
  }
})

function mountDialog(load: FlightRecorderGlobalLoad, options: { height?: number } = {}) {
  const client = {} as TuiPluginApi["client"]
  return mount(
    {
      client,
      children: () => (
        <DialogFlightRecorderGlobal
          load={load}
          directory="D:/work/redcode"
          now={() => FIXED_NOW}
          openSession={(sessionID) => {
            void sessionID
          }}
        />
      ),
    },
    { height: options.height ?? 110 },
  )
}

test("global dialog shows both ledgers, valid samples, currencies and truncation without adding them up", async () => {
  const load: FlightRecorderGlobalLoad = {
    summary: async () => ({ data: richSummary }),
    rows: async () => ({ data: globalPage([globalRow({ modelID: "visible-model" })]) }),
  }
  const modal = await mountDialog(load)
  try {
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("账面命中率"))
    expect(frame).toContain("账本 A · 账单步骤")
    expect(frame).toContain("65%")
    expect(frame).toContain("有效样本 1")
    expect(frame).toContain("无效 1")
    expect(frame).toContain("缺报 1")
    expect(frame).toContain("US$0.25 已记账")
    expect(frame).toContain("实报命中率")
    expect(frame).toContain("40%")
    expect(frame).toContain("扫描预算已满")
    expect(frame).toContain("不推断重试")
    expect(frame).toContain("双账本")
    // 容量策略来自服务端响应；默认值只作为服务端字段展示，不写死成结论。
    expect(frame).toContain("全局 100,000 条")
    expect(frame).toContain("每会话 128 条")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("global filters reload only what they must and never mix the two ledgers", async () => {
  const calls: { kind: "summary" | "rows"; query: Record<string, unknown> }[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async (query) => {
      calls.push({ kind: "summary", query })
      return { data: richSummary }
    },
    rows: async (query) => {
      calls.push({ kind: "rows", query })
      return { data: globalPage([globalRow({ modelID: "filter-model" })]) }
    },
  }
  const modal = await mountDialog(load)
  const last = (kind: "summary" | "rows") => [...calls].reverse().find((call) => call.kind === kind)!.query
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("来源 · 账单步骤"))
    expect(calls.map((call) => call.kind)).toEqual(["summary", "rows"])

    await modal.clickRow("来源 · 账单步骤")
    await modal.until(() => modal.app.captureCharFrame().includes("来源 · 请求尝试"))
    // 只换了记录来源，摘要不必重拉。
    expect(calls.filter((call) => call.kind === "summary")).toHaveLength(1)
    expect(last("rows")).toMatchObject({ source: "requests", limit: 30 })

    await modal.clickRow("时间 · 全部时间")
    await modal.until(() => modal.app.captureCharFrame().includes("时间 · 今天"))
    const today = new Date(2026, 10, 26).getTime()
    expect(last("summary")).toMatchObject({ from: today })
    expect(last("rows")).toMatchObject({ from: today, source: "requests" })

    await modal.clickRow("模型 · 全部")
    await modal.until(() => modal.app.captureCharFrame().includes("执行历史 · 选择模型"))
    await modal.clickRow("openai/gpt-test")
    await modal.until(() => modal.app.captureCharFrame().includes("模型 · openai/gpt-test"))
    expect(last("rows")).toMatchObject({ providerID: "openai", modelID: "gpt-test" })

    await modal.clickRow("工作区 · 全部")
    await modal.until(() => modal.app.captureCharFrame().includes("执行历史 · 选择工作区"))
    await modal.clickRow("ws_alpha")
    await modal.until(() => modal.app.captureCharFrame().includes("工作区 · ws_alpha"))
    expect(last("rows")).toMatchObject({ workspaceID: "ws_alpha" })

    await modal.clickRow("会话 · 全部")
    await modal.until(() => modal.app.captureCharFrame().includes("按会话过滤"))
    await modal.until(() => modal.app.renderer.currentFocusedEditor !== null)
    await modal.app.mockInput.typeText("ses_beta")
    modal.app.mockInput.pressEnter()
    await modal.until(() => modal.app.captureCharFrame().includes("会话 · ses_beta"))
    expect(last("rows")).toMatchObject({ sessionID: "ses_beta" })

    await modal.clickRow("清除筛选")
    await modal.until(() => modal.app.captureCharFrame().includes("时间 · 全部时间"))
    expect(last("summary")).toEqual({})
    // 来源是账本选择，不属于筛选；清除后仍停在请求账本。
    expect(last("rows")).toEqual({ source: "requests", limit: 30 })
  } finally {
    modal.app.renderer.destroy()
  }
})

test("global groups apply their ledger filters and day groups scope the time range", async () => {
  const calls: { kind: "summary" | "rows"; query: Record<string, unknown> }[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async (query) => {
      calls.push({ kind: "summary", query })
      return { data: richSummary }
    },
    rows: async (query) => {
      calls.push({ kind: "rows", query })
      return { data: globalPage([globalRow({ modelID: "group-model" })]) }
    },
  }
  const modal = await mountDialog(load)
  const last = (kind: "summary" | "rows") => [...calls].reverse().find((call) => call.kind === kind)!.query
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("按日期"))
    await modal.clickRow("2026-11-25")
    await modal.until(() => modal.app.captureCharFrame().includes("时间 · 2026-11-25"))
    const from = new Date(2026, 10, 25).getTime()
    const to = new Date(2026, 10, 26).getTime()
    expect(last("summary")).toEqual({ from, to })
    expect(last("rows")).toMatchObject({ from, to, source: "steps" })
  } finally {
    modal.app.renderer.destroy()
  }
})

test("global rows page on demand, append older rows and stop at the end cursor", async () => {
  const calls: { before?: string }[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async () => ({ data: globalSummary({ steps: stepSummary({ samples: 2 }) }) }),
    rows: async (input) => {
      calls.push(input)
      if (input.before === undefined)
        return {
          data: globalPage(
            [
              globalRow({ id: "new", time: 3, modelID: "page-new" }),
              globalRow({ id: "mid", time: 2, modelID: "page-mid" }),
            ],
            { next: "cursor-1" },
          ),
        }
      return { data: globalPage([globalRow({ id: "old", time: 1, modelID: "page-old" })]) }
    },
  }
  const modal = await mountDialog(load)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("page-new"))
    expect(calls).toHaveLength(1)
    modal.app.mockInput.pressKey("l", { ctrl: true })
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("page-old"))
    expect(frame).toContain("page-new")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.before).toBe("cursor-1")

    modal.app.mockInput.pressKey("l", { ctrl: true })
    await modal.paint()
    expect(calls).toHaveLength(2)
  } finally {
    modal.app.renderer.destroy()
  }
})

test("changing filters clears the previous summary until the new one succeeds", async () => {
  let summaries = 0
  const pending: ((value: { data?: GlobalSummary }) => void)[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async () => {
      summaries++
      if (summaries === 1) return { data: richSummary }
      return new Promise((resolve) => pending.push(resolve))
    },
    rows: async () => ({ data: globalPage([globalRow()]) }),
  }
  const modal = await mountDialog(load)
  try {
    const initial = await modal.until(() => modal.app.captureCharFrame().includes("65%"))
    expect(initial).toContain("账本 A · 账单步骤")

    // 时间筛选变化后，新摘要还在途中：旧摘要不能继续挂在新条件下。
    await modal.clickRow("时间 · 全部时间")
    await modal.until(() => modal.app.captureCharFrame().includes("时间 · 今天"))
    await modal.paint()
    const loading = modal.app.captureCharFrame()
    expect(loading).toContain("摘要加载中…")
    expect(loading).not.toContain("65%")
    expect(loading).not.toContain("账本 A · 账单步骤")

    // 新摘要失败后也只能显示失败，不得回退成旧摘要。
    pending.at(-1)!({})
    const failed = await modal.until(() => modal.app.captureCharFrame().includes("摘要加载失败"))
    expect(failed).not.toContain("65%")
    expect(failed).not.toContain("账本 A · 账单步骤")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("refreshing clears the previous summary until the new one succeeds", async () => {
  let summaries = 0
  const pending: ((value: { data?: GlobalSummary }) => void)[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async () => {
      summaries++
      if (summaries === 1) return { data: richSummary }
      return new Promise((resolve) => pending.push(resolve))
    },
    rows: async () => ({ data: globalPage([globalRow()]) }),
  }
  const modal = await mountDialog(load)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("65%"))
    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => summaries === 2)
    await modal.paint()
    const loading = modal.app.captureCharFrame()
    expect(loading).toContain("摘要加载中…")
    expect(loading).not.toContain("65%")

    pending.at(-1)!({})
    const failed = await modal.until(() => modal.app.captureCharFrame().includes("摘要加载失败"))
    expect(failed).not.toContain("65%")
    expect(failed).not.toContain("账本 A · 账单步骤")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("empty pages with a next cursor keep paging until an older match appears", async () => {
  const beforeCalls: (string | undefined)[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async () => ({ data: quietSummary }),
    rows: async (input) => {
      beforeCalls.push(input.before)
      if (input.before === undefined) return { data: globalPage([], { next: "cursor-1" }) }
      if (input.before === "cursor-1") return { data: globalPage([], { next: "cursor-2" }) }
      return { data: globalPage([globalRow({ id: "older", modelID: "older-model" })]) }
    },
  }
  const modal = await mountDialog(load)
  try {
    const first = await modal.until(() => modal.app.captureCharFrame().includes("加载更早"))
    // 空页但有 next：还有更早的页没查，不能说“当前筛选没有记录”。
    expect(first).not.toContain("没有记录")
    expect(first).not.toContain("当前筛选没有")

    await modal.clickRow("加载更早")
    await modal.until(() => beforeCalls.length === 2)
    await modal.until(() => modal.app.captureCharFrame().includes("加载更早"))
    expect(beforeCalls).toEqual([undefined, "cursor-1"])

    // 空页返回新游标时不能丢弃它，否则永远到不了更早的匹配。
    await modal.clickRow("加载更早")
    await modal.until(() => beforeCalls.length === 3)
    const found = await modal.until(() => modal.app.captureCharFrame().includes("older-model"))
    expect(beforeCalls).toEqual([undefined, "cursor-1", "cursor-2"])
    expect(found).not.toContain("加载更早")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("retrying a failed older page keeps the failed cursor", async () => {
  const beforeCalls: (string | undefined)[] = []
  let fail = true
  const load: FlightRecorderGlobalLoad = {
    summary: async () => ({ data: quietSummary }),
    rows: async (input) => {
      beforeCalls.push(input.before)
      if (input.before === undefined) return { data: globalPage([], { next: "cursor-1" }) }
      if (fail) {
        fail = false
        throw new Error("offline")
      }
      return { data: globalPage([globalRow({ id: "retry-row", modelID: "retry-model" })]) }
    },
  }
  const modal = await mountDialog(load)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("加载更早"))
    await modal.clickRow("加载更早")
    await modal.until(() => modal.app.captureCharFrame().includes("加载失败"))
    // 首页为空时 rows().length 也是 0；重试不能用这个条件退回首页。
    await modal.clickRow("加载失败")
    const found = await modal.until(() => modal.app.captureCharFrame().includes("retry-model"))
    expect(found).toContain("retry-model")
    expect(beforeCalls).toEqual([undefined, "cursor-1", "cursor-1"])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("ctrl+r and ctrl+l stay actionable when the list filter has no matches", async () => {
  let summaryCalls = 0
  const rowCalls: (string | undefined)[] = []
  const load: FlightRecorderGlobalLoad = {
    summary: async () => {
      summaryCalls++
      return { data: quietSummary }
    },
    rows: async (input) => {
      rowCalls.push(input.before)
      return { data: globalPage([globalRow({ modelID: "row-model" })], { next: "cursor-1" }) }
    },
  }
  const modal = await mountDialog(load)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("row-model"))
    modal.app.mockInput.typeText("qqqq")
    await modal.until(() => modal.app.captureCharFrame().includes("没有匹配记录"))

    const summariesBefore = summaryCalls
    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => summaryCalls > summariesBefore)

    const rowsBefore = rowCalls.length
    modal.app.mockInput.pressKey("l", { ctrl: true })
    await modal.until(() => rowCalls.length > rowsBefore)
    expect(rowCalls.at(-1)).toBe("cursor-1")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("global time bounds, cost buckets and coverage keep missing values missing", () => {
  const bounds = flightRecorderTimeBounds({ key: "today" }, FIXED_NOW)
  expect(bounds.from).toBe(new Date(2026, 10, 26).getTime())
  expect(bounds.to).toBeUndefined()
  expect(flightRecorderTimeBounds({ key: "7d" }, FIXED_NOW).from).toBe(FIXED_NOW - 7 * 86_400_000)
  expect(flightRecorderTimeBounds({ key: "day", day: "2026-11-25" }, FIXED_NOW)).toMatchObject({
    from: new Date(2026, 10, 25).getTime(),
    to: new Date(2026, 10, 26).getTime(),
  })

  // 纯估算桶不能冒充“0 已记账”；估算为 0 也必须显示，不能省略。
  expect(formatGlobalCost([{ currency: "USD", booked: 0, estimated: 0, samples: 1, missing: 0 }])).toBe(
    "US$0.00 估算",
  )
  expect(
    formatGlobalCost([{ currency: "USD", booked: 0, estimated: 0.5, samples: 2, missing: 0 }]),
  ).toBe("US$0.50 估算")
  expect(
    formatGlobalCost([{ currency: "USD", booked: 0.25, estimated: 0, samples: 1, missing: 0 }]),
  ).toBe("US$0.25 已记账")
  expect(
    formatGlobalCost([{ currency: "USD", booked: 0.25, estimated: 0.1, samples: 2, missing: 0 }]),
  ).toBe("US$0.25 已记账 · US$0.10 估算")
  expect(
    formatGlobalCost([{ booked: 0, estimated: 0, samples: 0, missing: 2 }]),
  ).toContain("缺报 2")
  expect(formatGlobalCost([])).toContain("缺报不等于 0")

  expect(formatGlobalHitRate({ input: 0, read: 0, samples: 0, excluded: { invalid: 0, incomplete: 0 } })).toBe(
    "无有效样本",
  )
  expect(
    formatGlobalCoverage({ from: 0, to: 1000, scanned: 10, truncated: true }),
  ).toContain("已截断")

  // 容量策略只认服务端给的值；缺失时说未知，不把默认值写成当前生效值。
  expect(formatRetentionPolicy(undefined)).toBe("服务端未提供（默认/未知）")
  expect(formatRetentionPolicy({ requestsPerSession: 128 })).toBe("每会话 128 条")
  expect(
    formatRetentionPolicy({
      requestsPerSession: 128,
      totalRequests: 100_000,
    }),
  ).toBe("全局 100,000 条 · 每会话 128 条")
  expect(
    formatRetentionPolicy({
      requestsPerSession: 128,
      totalRequests: 100_000,
      retentionMs: 86_400_000,
    }),
  ).toBe("全局 100,000 条 · 每会话 128 条 · 时间保留 1 天")

  const merged = mergeFlightRecorderGlobalRows(
    [globalRow({ id: "a", time: 3 }), globalRow({ id: "b", time: 1 })],
    // 同 id 不同会话不是同一条记录
    [globalRow({ id: "b", time: 1 }), globalRow({ id: "b", time: 2, sessionID: "ses_other" }), globalRow({ id: "c", time: 4 })],
    10,
  )
  expect(merged.rows.map((row) => `${row.sessionID}:${row.id}`)).toEqual([
    "ses_alpha:c",
    "ses_alpha:a",
    "ses_other:b",
    "ses_alpha:b",
  ])
  expect(merged.total).toBe(4)
  const capped = mergeFlightRecorderGlobalRows([], [globalRow({ id: "x" }), globalRow({ id: "y" })], 1)
  expect(capped.rows).toHaveLength(1)
  expect(capped.total).toBe(2)
})
