/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { FlightRecorderPage, FlightRecorderRow } from "@redcode-ai/sdk/v2"
import { createSignal, onCleanup, type JSX } from "solid-js"
import {
  cacheHitLabel,
  cacheHitPercent,
  cacheMissLabel,
  DialogFlightRecorder,
  FLIGHT_RECORDER_MAX_ROWS,
  flightRecorderCapLabel,
  formatRecordedCost,
  formatRecordedDuration,
  formatRecordedNumber,
  mergeFlightRecorderRows,
  outcomeLabel,
  prefixParts,
  SidebarFlightRecorder,
  type FlightRecorderLoad,
} from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/dialog-flight-recorder"
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

function row(patch: Partial<FlightRecorderRow> = {}): FlightRecorderRow {
  return {
    id: "row_1",
    messageID: "msg_1",
    time: 1_700_000_000_000,
    modelID: "deepseek-v4",
    providerID: "opencode-go",
    outcome: "completed",
    ...patch,
  }
}

function Harness(props: {
  children: (api: TuiPluginApi) => JSX.Element
  onKeymap?: (keymap: ReturnType<typeof createDefaultOpenTuiKeymap>) => void
}) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createTuiResolvedConfig()
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  props.onKeymap?.(keymap)
  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={config}>
        <ThemeContext.Provider value={{ theme } as never}>
          <ToastProvider>
            <DialogProvider>
              <Bridge config={config}>{props.children}</Bridge>
            </DialogProvider>
          </ToastProvider>
        </ThemeContext.Provider>
      </TuiConfigProvider>
    </OpencodeKeymapProvider>
  )
}

function Bridge(props: {
  config: ReturnType<typeof createTuiResolvedConfig>
  children: (api: TuiPluginApi) => JSX.Element
}) {
  const dialog = useDialog()
  const api = {
    theme: { current: theme },
    ui: { dialog },
    tuiConfig: props.config,
  } as unknown as TuiPluginApi
  return props.children(api)
}

// 只验证入口自己的鼠标处理，不挂 DialogProvider（避免对话框遮罩参与命中测试）。
function EntryHarness(props: { children: (api: TuiPluginApi) => JSX.Element; onOpen: () => void }) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createTuiResolvedConfig()
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  const api = {
    theme: { current: theme },
    ui: { dialog: { replace: () => props.onOpen() } },
    tuiConfig: config,
  } as unknown as TuiPluginApi
  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={config}>
        <ThemeContext.Provider value={{ theme } as never}>{props.children(api)}</ThemeContext.Provider>
      </TuiConfigProvider>
    </OpencodeKeymapProvider>
  )
}

async function mount(children: (api: TuiPluginApi) => JSX.Element, options: { width?: number; height?: number } = {}) {
  let keymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined
  const app = await testRender(
    () => (
      <Harness
        onKeymap={(value) => {
          keymap = value
        }}
      >
        {children}
      </Harness>
    ),
    { width: options.width ?? 100, height: options.height ?? 32, kittyKeyboard: true },
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
  return { app, paint, until, keymap: () => keymap! }
}

function page(items: FlightRecorderRow[], next?: string): { data: FlightRecorderPage } {
  return { data: { items, next } }
}

// 261126 Red Flight Recorder V1 的侧栏入口：渲染侧栏不产生任何请求，键盘命令打开后才拉第一页。
test("sidebar entry stays lazy and opens the dialog on its keyboard command", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    return page([
      row({ id: "new", time: 1_700_000_200_000, modelID: "new-model" }),
      row({ id: "old", time: 1_700_000_100_000, modelID: "old-model" }),
    ])
  }
  const modal = await mount((api) => <SidebarFlightRecorder api={api} sessionID="ses_test" load={load} />)
  try {
    const initial = await modal.paint()
    expect(initial).toContain("Flight Recorder")
    expect(calls.length).toBe(0)
    const bindings = modal.keymap().getCommandBindings({
      visibility: "registered",
      commands: ["sidebar.flight_recorder.open"],
    })
    expect((bindings.get("sidebar.flight_recorder.open") ?? []).length).toBeGreaterThan(0)

    // 真实按键：默认 <leader>o（leader = ctrl+x）
    modal.app.mockInput.pressKey("x", { ctrl: true })
    modal.app.mockInput.pressKey("o")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("new-model"))
    expect(frame).toContain("执行历史 · 账单步骤（旧历史）")
    expect(calls.length).toBe(1)
    expect(calls[0]).toMatchObject({ sessionID: "ses_test", source: "steps", limit: 30 })
    expect(calls[0]!.before).toBeUndefined()
    // 最新在前
    expect(frame.indexOf("new-model")).toBeLessThan(frame.indexOf("old-model"))
  } finally {
    modal.app.renderer.destroy()
  }
})

// 鼠标入口沿用侧栏既有做法：点这一行就打开，不需要键盘。
test("sidebar entry also opens with a mouse click", async () => {
  let opened = 0
  const app = await testRender(
    () => (
      <EntryHarness onOpen={() => opened++}>
        {(api) => <SidebarFlightRecorder api={api} sessionID="ses_test" load={async () => page([])} />}
      </EntryHarness>
    ),
    { width: 40, height: 5, kittyKeyboard: true },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Flight Recorder")
    await app.mockMouse.click(3, 0)
    await app.renderOnce()
    expect(opened).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

// 真实对话框在 50 列终端下只有 48 列宽：模型/结果可截，但行首命中率不能一起被截掉。
test("entry dialog keeps row hit rates visible on a narrow terminal", async () => {
  const load: FlightRecorderLoad = async () =>
    page([
      row({ id: "low", time: 1_700_000_300_000, modelID: "deepseek-v4", input: 1000, cacheRead: 321 }),
      row({ id: "lower", time: 1_700_000_200_000, modelID: "deepseek-v4", input: 1000, cacheRead: 125 }),
    ])
  const modal = await mount((api) => <SidebarFlightRecorder api={api} sessionID="ses_test" load={load} />, {
    width: 50,
    height: 20,
  })
  try {
    modal.keymap().dispatchCommand("sidebar.flight_recorder.open")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("32.1%"))
    expect(frame).toContain("12.5%")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("switching source never lets a late response from the previous source through", async () => {
  const pending = new Map<string, (value: { data: FlightRecorderPage }) => void>()
  const load: FlightRecorderLoad = (input) => new Promise((resolve) => pending.set(input.source, resolve))
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => pending.has("steps"))
    modal.keymap().dispatchCommand("sidebar.flight_recorder.source")
    await modal.until(() => pending.has("requests"))

    pending.get("requests")!(page([row({ id: "req", modelID: "requests-model" })]))
    await modal.until(() => modal.app.captureCharFrame().includes("requests-model"))
    // 旧来源的迟到响应晚到，不能覆盖当前来源
    pending.get("steps")!(page([row({ id: "step", modelID: "steps-model" })]))
    await modal.paint()
    await modal.paint()
    const frame = modal.app.captureCharFrame()
    expect(frame).toContain("requests-model")
    expect(frame).not.toContain("steps-model")
  } finally {
    modal.app.renderer.destroy()
  }
})

test("row detail shows recorded tokens, cost currency, same-model prefix and summary only when present", async () => {
  const load: FlightRecorderLoad = async (input) =>
    input.source === "steps"
      ? page([])
      : page([
          row({
            id: "detail",
            modelID: "deepseek-v4",
            providerID: "opencode-go",
            outcome: "completed",
            input: 1000,
            output: 250,
            cacheRead: 400,
            cacheWrite: 100,
            cacheMiss: 500,
            cost: 0.015,
            currency: "USD",
            durationMs: 4200,
            firstEventMs: 800,
            prefix: { system: "unchanged", tools: "append", history: "rewind", compressed: true },
            summary: true,
          }),
        ])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    modal.keymap().dispatchCommand("sidebar.flight_recorder.source")
    const listFrame = await modal.until(() => modal.app.captureCharFrame().includes("deepseek-v4"))
    // 列表就能直接看到命中率，不必逐行点开
    expect(listFrame).toContain("40%")
    modal.keymap().dispatchCommand("dialog.select.submit")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))

    expect(frame).toContain("opencode-go/deepseek-v4")
    expect(frame).toContain("结果 完成")
    expect(frame).toContain("摘要消息")
    expect(frame).toContain("输入（含缓存） 1,000")
    expect(frame).toContain("输出（含推理） 250")
    expect(frame).toContain("缓存命中 400")
    expect(frame).toContain("缓存未命中（含写入） 500")
    expect(frame).toContain("缓存写入 100")
    expect(frame).toContain("实报命中率 40%")
    expect(frame).toContain("费用 US$0.02")
    expect(frame).toContain("耗时 4.2s")
    expect(frame).toContain("首事件 800ms")
    expect(frame).toContain("tools 追加")
    expect(frame).toContain("history 回退")
    expect(frame).toContain("已压缩")

    modal.keymap().dispatchCommand("sidebar.flight_recorder.back")
    const list = await modal.until(() => modal.app.captureCharFrame().includes("执行历史"))
    expect(list).not.toContain("执行记录详情")
  } finally {
    modal.app.renderer.destroy()
  }
})

// 旧账的 booked 行允许账面命中率，包括记账归零；列表也要直接显示 0%。
test("booked ledger rows expose the ledger hit rate including a recorded zero", async () => {
  const load: FlightRecorderLoad = async () =>
    page([
      row({
        id: "ledger",
        modelID: "ledger-model",
        outcome: "booked",
        input: 100,
        cacheRead: 0,
        cacheWrite: 100,
        cacheMiss: 0,
      }),
    ])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    const list = await modal.until(() => modal.app.captureCharFrame().includes("ledger-model"))
    expect(list).toContain("0%")
    modal.keymap().dispatchCommand("dialog.select.submit")
    const detail = await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))
    expect(detail).toContain("结果 账单")
    expect(detail).toContain("账面命中率 0%")
    // steps 的 miss 是 adjustedInput（不含写入），和 requests 的含写入口径分开标
    expect(detail).toContain("缓存未命中（不含写入） 0")
    expect(detail).toContain("记账 0 可能来自缺报归零")
  } finally {
    modal.app.renderer.destroy()
  }
})

// 窄宽下 title/description 会被裁，但行首 gutter 的命中率必须还看得见。
test("narrow dialogs keep the per-row cache rate visible", async () => {
  const load: FlightRecorderLoad = async () =>
    page([
      row({ id: "low", time: 1_700_000_300_000, modelID: "deepseek-v4", input: 1000, cacheRead: 321 }),
      row({ id: "lower", time: 1_700_000_200_000, modelID: "deepseek-v4", input: 1000, cacheRead: 125 }),
    ])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />, { width: 50, height: 24 })
  try {
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("32.1%"))
    expect(frame).toContain("12.5%")
    expect(frame).toContain("deepseek")
  } finally {
    modal.app.renderer.destroy()
  }
})

// 到上限必须说明“更早的没加载/没保留”，不能画成整个会话都已列出。
test("hitting the cap says older records were not loaded", async () => {
  let calls = 0
  const load: FlightRecorderLoad = async () => {
    calls++
    return calls === 1
      ? page([row({ id: "a", time: 5, modelID: "cap-a" }), row({ id: "b", time: 4, modelID: "cap-b" })], "cursor-1")
      : page([row({ id: "c", time: 3, modelID: "cap-c" }), row({ id: "d", time: 2, modelID: "cap-d" })], "cursor-2")
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={2} maxRows={3} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("cap-a"))
    modal.keymap().dispatchCommand("sidebar.flight_recorder.more")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("cap-c"))
    expect(frame).toContain("已到上限")
    expect(frame).toContain("更早记录未加载")
    expect(frame).not.toContain("已到 最早")

    modal.keymap().dispatchCommand("sidebar.flight_recorder.more")
    await modal.paint()
    expect(calls).toBe(2)
  } finally {
    modal.app.renderer.destroy()
  }
})

test("paging loads only on demand, appends older rows and stops at the end cursor", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    if (input.before === undefined) {
      return page(
        [
          row({ id: "a", time: 1_700_000_300_000, modelID: "newest" }),
          row({ id: "b", time: 1_700_000_200_000, modelID: "middle" }),
        ],
        "cursor-1",
      )
    }
    return page([row({ id: "c", time: 1_700_000_100_000, modelID: "oldest" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("newest"))
    expect(calls.length).toBe(1)

    // 真实按键翻页（动作绑定 ctrl+l）
    modal.app.mockInput.pressKey("l", { ctrl: true })
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("oldest"))
    expect(calls.length).toBe(2)
    expect(calls[1]).toMatchObject({ source: "steps", before: "cursor-1", limit: 30 })
    expect(frame).toContain("newest")
    expect(frame).toContain("已到 最早")

    modal.keymap().dispatchCommand("sidebar.flight_recorder.more")
    await modal.paint()
    expect(calls.length).toBe(2)
  } finally {
    modal.app.renderer.destroy()
  }
})

test("initial failure shows an error row and retry succeeds; empty source can still switch", async () => {
  let calls = 0
  const load: FlightRecorderLoad = async (input) => {
    calls++
    if (input.source === "steps") {
      if (calls === 1) throw new Error("offline")
      return page([])
    }
    return page([row({ id: "req", modelID: "requests-only" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    const errorFrame = await modal.until(() => modal.app.captureCharFrame().includes("加载失败"))
    expect(errorFrame).toContain("offline")
    // 真实按键重试（动作绑定 ctrl+r），不是只调命令
    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    expect(calls).toBe(2)

    // 空列表没有可选行，但状态行仍在，来源切换动作必须可用
    modal.keymap().dispatchCommand("sidebar.flight_recorder.source")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("requests-only"))
    expect(frame).toContain("执行历史 · 请求尝试（新记录 · 最多 128 条）")
    expect(calls).toBe(3)
  } finally {
    modal.app.renderer.destroy()
  }
})

test("session changes drop the old list and issue a fresh first page", async () => {
  const [session, setSession] = createSignal("first")
  const pending: string[] = []
  const load: FlightRecorderLoad = async (input) => {
    pending.push(input.sessionID)
    if (input.sessionID === "first") {
      await Bun.sleep(30)
      return page([row({ id: "first", modelID: "first-model" })])
    }
    return page([row({ id: "second", modelID: "second-model" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID={session()} load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("first-model"))
    setSession("second")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("second-model"))
    expect(frame).not.toContain("first-model")
    expect(pending).toEqual(["first", "second"])
  } finally {
    modal.app.renderer.destroy()
  }
})

test("unknown values stay unknown and 0 stays 0; no hit rate for estimates, booked rows or bad cache data", () => {
  expect(formatRecordedNumber(undefined)).toBe("未采集")
  expect(formatRecordedNumber(0)).toBe("0")
  expect(formatRecordedCost(undefined, "USD")).toBe("未采集")
  expect(formatRecordedCost(0, "USD")).toBe("US$0.00")
  expect(formatRecordedCost(1.5, "CNY")).toBe("¥1.50")
  expect(formatRecordedCost(2, undefined)).toContain("币种未采集")
  expect(formatRecordedDuration(undefined)).toBe("未采集")
  expect(formatRecordedDuration(0)).toBe("0ms")
  expect(outcomeLabel("booked")).toBe("账单")
  expect(outcomeLabel("unknown")).toBe("未知")

  expect(cacheHitPercent({ outcome: "completed", input: 100, cacheRead: 20 })).toBe(20)
  expect(cacheHitPercent({ outcome: "completed", input: 100, cacheRead: 0 })).toBe(0)
  expect(cacheHitPercent({ outcome: "completed", input: undefined, cacheRead: 0 })).toBeUndefined()
  expect(cacheHitPercent({ outcome: "completed", input: 100, cacheRead: undefined })).toBeUndefined()
  expect(cacheHitPercent({ outcome: "completed", input: 100, cacheRead: 101 })).toBeUndefined()
  expect(cacheHitPercent({ outcome: "completed", input: 0, cacheRead: 0 })).toBeUndefined()
  expect(cacheHitPercent({ outcome: "estimated", input: 100, cacheRead: 20 })).toBeUndefined()
  expect(cacheHitPercent({ outcome: "unknown", input: 100, cacheRead: 20 })).toBeUndefined()
  // 旧账的 0 是记账归零，不是供应商显式 0；要计入而不是当成缺样本剔除
  expect(cacheHitPercent({ outcome: "booked", input: 100, cacheRead: 20 })).toBe(20)
  expect(cacheHitPercent({ outcome: "booked", input: 100, cacheRead: 0 })).toBe(0)
  expect(cacheHitPercent({ outcome: "booked", input: 0, cacheRead: 0 })).toBeUndefined()
  expect(cacheHitPercent({ outcome: "booked", input: 100, cacheRead: 101 })).toBeUndefined()
  expect(cacheHitLabel({ outcome: "booked" })).toBe("账面命中率")
  expect(cacheHitLabel({ outcome: "completed" })).toBe("实报命中率")
  // requests 的 miss 已含写入；steps 的 miss 不含写入——标签不能让人把三个桶相加超过 input
  expect(cacheMissLabel("requests")).toBe("缓存未命中（含写入）")
  expect(cacheMissLabel("steps")).toBe("缓存未命中（不含写入）")
  expect(flightRecorderCapLabel("steps")).toBe("更早记录未加载")
  expect(flightRecorderCapLabel("requests")).toBe("更早请求未保留")

  const prefix = { system: "baseline", tools: "unchanged", history: "rewrite", compressed: false } as const
  expect(prefixParts(prefix)).toEqual(["system 基线", "tools 未变", "history 重写"])
  expect(prefixParts({ ...prefix, compressed: true })).toContain("已压缩")
})

test("merge dedupes, sorts newest first and caps accumulated rows", () => {
  const rows = mergeFlightRecorderRows(
    [row({ id: "a", time: 3 }), row({ id: "b", time: 1 })],
    [row({ id: "b", time: 1 }), row({ id: "c", time: 2 })],
    10,
  )
  expect(rows.map((item) => item.id)).toEqual(["a", "c", "b"])

  const capped = mergeFlightRecorderRows(
    [],
    Array.from({ length: FLIGHT_RECORDER_MAX_ROWS.steps + 10 }, (_, index) => row({ id: `r${index}`, time: index })),
    FLIGHT_RECORDER_MAX_ROWS.steps,
  )
  expect(capped.length).toBe(FLIGHT_RECORDER_MAX_ROWS.steps)
  expect(capped[0]!.id).toBe(`r${FLIGHT_RECORDER_MAX_ROWS.steps + 9}`)
  // 两个源允许不同上限：请求尝试受服务端保留窗口约束
  expect(FLIGHT_RECORDER_MAX_ROWS.requests).toBe(128)
})
