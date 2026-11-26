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
  flightRecorderCap,
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

// 服务端 Schema 已投影步骤账的可选 requestID；SDK 类型未生成前用运行时字段验证展示与跳转。
function stepRow(patch: Partial<FlightRecorderRow> = {}, requestID?: string): FlightRecorderRow {
  return {
    ...row({ outcome: "booked", ...patch }),
    ...(requestID === undefined ? {} : { requestID }),
  } as FlightRecorderRow
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

test("sidebar click leaves the dialog open after release and the dialog remains interactive", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    return page([row({ modelID: "mouse-model" })])
  }
  const modal = await mount((api) => (
    <box position="absolute" left={82} top={14} width={18}>
      <SidebarFlightRecorder api={api} sessionID="ses_test" load={load} />
    </box>
  ))
  const { mockMouse, mockInput, renderer } = modal.app
  try {
    expect(await modal.paint()).toContain("Flight Recorder")
    expect(calls).toHaveLength(0)

    await mockMouse.pressDown(88, 14)
    await modal.paint()
    const callsBeforeRelease = calls.length
    await mockMouse.release(88, 14)
    const list = await modal.paint()
    expect(list).toContain("mouse-model")
    expect(callsBeforeRelease).toBe(0)
    expect(calls).toHaveLength(1)

    const rowY = list.split("\n").findIndex((line) => line.includes("mouse-model"))
    await mockMouse.click(40, rowY)
    await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))
    expect(calls).toHaveLength(1)
    mockInput.pressArrow("left")
    await modal.until(() => modal.app.captureCharFrame().includes("执行历史"))
    mockInput.pressEscape()
    await modal.until(() => !modal.app.captureCharFrame().includes("执行历史"))

    await mockMouse.click(88, 14)
    expect(await modal.paint()).toContain("mouse-model")
    expect(calls).toHaveLength(2)
    await mockMouse.click(3, 14)
    await modal.until(() => !modal.app.captureCharFrame().includes("执行历史"))
  } finally {
    renderer.destroy()
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
test("request diagnostics are reachable by scrolling a terminal detail", async () => {
  const section = { change: "unchanged", count: 1, bytes: 50 } as const
  const load: FlightRecorderLoad = async (input) =>
    input.source === "steps"
      ? page([])
      : page([
          row({
            id: "diagnostic",
            time: 1_700_000_200_000,
            modelID: "low-model",
            input: 100,
            cacheRead: 32,
            diagnostics: {
              version: 1,
              runtime: "ai-sdk",
              capture: {
                status: "captured",
                previousRequestID: "comparison-request",
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
          }),
          row({ id: "comparison-request", time: 1_700_000_100_000, input: 100, cacheRead: 98 }),
        ])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />, { height: 26 })
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    modal.app.mockInput.pressKey("s", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("low-model"))
    modal.keymap().dispatchCommand("dialog.select.submit")
    const top = await modal.until(() => modal.app.captureCharFrame().includes("基准命中率"))
    expect(top).toContain("基准命中率 98%")
    modal.app.mockInput.pressKey("\u001b[6~")
    const bottom = await modal.until(() => modal.app.captureCharFrame().includes("未归因的未读缓存输入"))
    expect(bottom).toContain("未归因的未读缓存输入 38")
    expect(bottom).toContain("读取 0")
  } finally {
    modal.app.renderer.destroy()
  }
})

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
    // 步骤账没有服务端投影的 requestID 时明确写未关联，不按位置猜。
    expect(detail).toContain("请求关联 未关联")
    // steps 的 miss 是 adjustedInput（不含写入），和 requests 的含写入口径分开标
    expect(detail).toContain("缓存未命中（不含写入） 0")
    // 详情变长后记账说明在首屏之外，按真实 PageDown 滚动后再读。
    modal.app.mockInput.pressKey("\u001b[6~")
    const bottom = await modal.until(() => modal.app.captureCharFrame().includes("记账 0 可能来自缺报归零"))
    expect(bottom).toContain("记账 0 可能来自缺报归零")
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

// 容量策略由服务端决定：会话分页响应不提供保留策略时，128 条只是客户端显示上限，
// 不能声称“保留上限已达”，也不能断言发生过淘汰。
test("requests reaching the client cap without next do not claim a server retention limit", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    if (input.source === "steps") return page([])
    return page(
      Array.from({ length: 150 }, (_, index) =>
        row({ id: `retained-${index}`, time: 1_700_000_000_000 - index, modelID: "retained-model" }),
      ),
    )
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={150} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    modal.app.mockInput.pressKey("s", { ctrl: true })
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("保留策略"))
    expect(frame).toContain("未提供（默认/未知）")
    expect(frame).toContain("返回范围最早")
    expect(frame).not.toContain("保留上限已达")
    expect(frame).not.toContain("更早请求是否发生淘汰未知")
    expect(frame).not.toContain("更早请求未保留")
    expect(calls.at(-1)).toMatchObject({ source: "requests", limit: 150 })
    expect(calls.at(-1)!.before).toBeUndefined()
  } finally {
    modal.app.renderer.destroy()
  }
})

// next 存在但客户端先到行数上限：只能说明“更早记录未加载”，不能说未保留。
test("requests stopping at the client row limit with next say older requests were not loaded", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    if (input.source === "steps") return page([])
    if (input.before === undefined) {
      return page([row({ id: "a", time: 5, modelID: "req-new" }), row({ id: "b", time: 4, modelID: "req-mid" })], "cursor-1")
    }
    return page(
      [row({ id: "c", time: 3, modelID: "req-old" }), row({ id: "d", time: 2, modelID: "req-older" })],
      "cursor-2",
    )
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={2} maxRows={3} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    modal.app.mockInput.pressKey("s", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("req-new"))
    modal.app.mockInput.pressKey("l", { ctrl: true })
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("已到上限"))
    expect(frame).toContain("更早请求未加载")
    expect(frame).not.toContain("保留上限已达")
    expect(calls.at(-1)).toMatchObject({ source: "requests", before: "cursor-1", limit: 2 })
  } finally {
    modal.app.renderer.destroy()
  }
})

// steps 的语义不变：恰好到上限且没有 next 时，服务端已证明这是完整列表。
test("steps landing exactly on the row limit without next stay complete", async () => {
  const load: FlightRecorderLoad = async () =>
    page([row({ id: "a", time: 2, modelID: "step-a" }), row({ id: "b", time: 1, modelID: "step-b" })])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={2} maxRows={2} />)
  try {
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("step-a"))
    expect(frame).toContain("已到 最早")
    expect(frame).not.toContain("已到上限")
    expect(frame).not.toContain("更早记录未加载")
  } finally {
    modal.app.renderer.destroy()
  }
})

// 首屏返回的行超过客户端上限：被切掉的行同样属于“更早的没加载”。
test("a first page cut by the client row limit still says older records were not loaded", async () => {
  const load: FlightRecorderLoad = async () =>
    page([
      row({ id: "a", time: 5, modelID: "first-a" }),
      row({ id: "b", time: 4, modelID: "first-b" }),
      row({ id: "c", time: 3, modelID: "first-c" }),
      row({ id: "d", time: 2, modelID: "first-d" }),
    ])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={4} maxRows={3} />)
  try {
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("first-a"))
    expect(frame).toContain("已到上限")
    expect(frame).toContain("更早记录未加载")
    expect(frame).not.toContain("已到 最早")
    expect(frame).not.toContain("first-d")
  } finally {
    modal.app.renderer.destroy()
  }
})

// maxRows=3：先 2 条、下一页 2 条且无 next——第 4 条被客户端切掉，不能显示“已到最早”。
test("a page whose tail is cut by the client cap still marks older records as not loaded", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    if (input.before === undefined) {
      return page([row({ id: "a", time: 5, modelID: "cut-a" }), row({ id: "b", time: 4, modelID: "cut-b" })], "cursor-1")
    }
    return page([row({ id: "c", time: 3, modelID: "cut-c" }), row({ id: "d", time: 2, modelID: "cut-d" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={2} maxRows={3} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("cut-a"))
    modal.app.mockInput.pressKey("l", { ctrl: true })
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("cut-c"))
    expect(frame).toContain("已到上限")
    expect(frame).toContain("更早记录未加载")
    expect(frame).not.toContain("已到 最早")
    expect(frame).not.toContain("cut-d")
    // 被切掉后 cursor 不再保留，不能继续翻页
    modal.app.mockInput.pressKey("l", { ctrl: true })
    await modal.paint()
    expect(calls).toHaveLength(2)
  } finally {
    modal.app.renderer.destroy()
  }
})

// requests 远低于客户端显示上限时同样适用：没有 next 但本页被切掉，仍是“未加载”而非“已到最早”。
test("requests cut by the client cap below the display limit say older requests were not loaded", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    if (input.source === "steps") return page([])
    if (input.before === undefined) {
      return page(
        [row({ id: "a", time: 5, modelID: "req-cut-a" }), row({ id: "b", time: 4, modelID: "req-cut-b" })],
        "cursor-1",
      )
    }
    return page([row({ id: "c", time: 3, modelID: "req-cut-c" }), row({ id: "d", time: 2, modelID: "req-cut-d" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} pageSize={2} maxRows={3} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    modal.app.mockInput.pressKey("s", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("req-cut-a"))
    modal.app.mockInput.pressKey("l", { ctrl: true })
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("req-cut-c"))
    expect(frame).toContain("已到上限")
    expect(frame).toContain("更早请求未加载")
    expect(frame).not.toContain("更早请求是否发生淘汰未知")
    expect(frame).not.toContain("已到 最早")
    expect(calls.at(-1)).toMatchObject({ source: "requests", before: "cursor-1", limit: 2 })
  } finally {
    modal.app.renderer.destroy()
  }
})

// Ctrl+R 是主动刷新当前来源，不是只有出错时才可用的重试。
test("ctrl+r refreshes the current source and drops the previous page", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    const attempt = calls.filter((item) => item.source === input.source).length
    if (input.source === "steps") {
      return page([row({ id: `step-${attempt}`, modelID: attempt === 1 ? "steps-initial" : "steps-refreshed" })])
    }
    return page([row({ id: `req-${attempt}`, modelID: attempt === 1 ? "requests-initial" : "requests-refreshed" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("steps-initial"))
    modal.app.mockInput.pressKey("r", { ctrl: true })
    const steps = await modal.until(() => modal.app.captureCharFrame().includes("steps-refreshed"))
    expect(steps).not.toContain("steps-initial")

    modal.app.mockInput.pressKey("s", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("requests-initial"))
    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("requests-refreshed"))

    expect(calls.map((item) => item.source)).toEqual(["steps", "steps", "requests", "requests"])
    expect(calls[1]).toMatchObject({ source: "steps", limit: 30 })
    expect(calls[1]!.before).toBeUndefined()
    expect(calls[3]).toMatchObject({ source: "requests", limit: 30 })
    expect(calls[3]!.before).toBeUndefined()
  } finally {
    modal.app.renderer.destroy()
  }
})

// 过滤无匹配时动作不能因为 selected() 为空被静默吞掉：刷新/加载更早仍应执行。
test("ctrl+r and ctrl+l stay usable when the list filter has no matches", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    return page([row({ modelID: "visible-model" })], "cursor-1")
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("visible-model"))
    modal.app.mockInput.typeText("qqqq")
    await modal.until(() => modal.app.captureCharFrame().includes("没有匹配记录"))

    const beforeRefresh = calls.length
    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => calls.length > beforeRefresh)
    expect(calls.at(-1)!.before).toBeUndefined()

    const beforeMore = calls.length
    modal.app.mockInput.pressKey("l", { ctrl: true })
    await modal.until(() => calls.length > beforeMore)
    expect(calls.at(-1)).toMatchObject({ before: "cursor-1", source: "steps" })
  } finally {
    modal.app.renderer.destroy()
  }
})

// 刷新和分页并发：刷新后到达的旧分页响应必须被丢弃，不能覆盖新列表。
test("refresh discards paging responses that were already in flight", async () => {
  const pending: {
    input: Parameters<FlightRecorderLoad>[0]
    resolve: (value: { data: FlightRecorderPage }) => void
  }[] = []
  const load: FlightRecorderLoad = (input) => new Promise((resolve) => pending.push({ input, resolve }))
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => pending.length === 1)
    pending[0]!.resolve(
      page(
        [
          row({ id: "first", time: 5, modelID: "before-refresh" }),
          row({ id: "second", time: 4, modelID: "before-refresh-old" }),
        ],
        "cursor-1",
      ),
    )
    await modal.until(() => modal.app.captureCharFrame().includes("before-refresh"))

    modal.app.mockInput.pressKey("l", { ctrl: true })
    await modal.until(() => pending.length === 2)
    expect(pending[1]!.input).toMatchObject({ source: "steps", before: "cursor-1" })

    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => pending.length === 3)
    expect(pending[2]!.input).toMatchObject({ source: "steps", limit: 30 })
    expect(pending[2]!.input.before).toBeUndefined()

    pending[2]!.resolve(page([row({ id: "fresh", time: 9, modelID: "after-refresh" })]))
    await modal.until(() => modal.app.captureCharFrame().includes("after-refresh"))

    // 旧分页响应晚到：不能覆盖刷新结果，也不能把加载态卡住
    pending[1]!.resolve(page([row({ id: "stale", time: 1, modelID: "stale-page" })]))
    await modal.paint()
    await modal.paint()
    const frame = modal.app.captureCharFrame()
    expect(frame).toContain("after-refresh")
    expect(frame).not.toContain("stale-page")
    expect(frame).not.toContain("加载中")
  } finally {
    modal.app.renderer.destroy()
  }
})

// 分页失败后，列表末尾的错误行仍是可重试路径（Enter 用同一个 before 再试）。
test("a failed older-page load keeps the error-row retry path on the same cursor", async () => {
  const calls: Parameters<FlightRecorderLoad>[0][] = []
  const load: FlightRecorderLoad = async (input) => {
    calls.push(input)
    if (input.before === undefined) {
      return page(
        [row({ id: "a", time: 5, modelID: "page-one" }), row({ id: "b", time: 4, modelID: "page-one-old" })],
        "cursor-1",
      )
    }
    if (calls.filter((item) => item.before !== undefined).length === 1) throw new Error("paging down")
    return page([row({ id: "c", time: 3, modelID: "page-two" })])
  }
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("page-one"))
    modal.app.mockInput.pressKey("l", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("加载更早失败"))
    // 真实按键：下移到错误行，Enter 重试同一个 before
    modal.app.mockInput.pressArrow("down")
    modal.app.mockInput.pressArrow("down")
    modal.app.mockInput.pressEnter()
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("page-two"))
    expect(frame).not.toContain("加载更早失败")
    expect(calls.at(-1)).toMatchObject({ source: "steps", before: "cursor-1", limit: 30 })
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

test("initial failure shows an error row and ctrl+r refresh recovers; empty source can still switch", async () => {
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
    // 真实按键刷新（动作绑定 ctrl+r），失败后重拉当前来源
    modal.app.mockInput.pressKey("r", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("没有执行记录"))
    expect(calls).toBe(2)

    // 空列表没有可选行，但状态行仍在，来源切换动作必须可用
    modal.keymap().dispatchCommand("sidebar.flight_recorder.source")
    const frame = await modal.until(() => modal.app.captureCharFrame().includes("requests-only"))
    expect(frame).toContain("执行历史 · 请求尝试（新记录）")
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

// 261126 Red FR-06：步骤账的 requestID 只在服务端投影且已加载到对应请求时才提供跳转。
// 没加载到就明确写“不能据此判断已淘汰”，不扫描分页、不按位置猜对应关系。
test("step detail shows the projected request id and links only to an already loaded request", async () => {
  const load: FlightRecorderLoad = async (input) =>
    input.source === "steps"
      ? page([
          stepRow(
            { id: "step-1", modelID: "step-model", cost: 0.5, currency: "USD", input: 1000, cacheRead: 200 },
            "req_abc",
          ),
        ])
      : page([row({ id: "req_abc", modelID: "request-model", outcome: "completed", input: 1000, cacheRead: 400 })])
  const modal = await mount(() => <DialogFlightRecorder sessionID="ses_test" load={load} />)
  try {
    await modal.until(() => modal.app.captureCharFrame().includes("step-model"))
    modal.keymap().dispatchCommand("dialog.select.submit")
    const first = await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))
    expect(first).toContain("请求关联 req_abc")
    expect(first).toContain("不能据此判断已淘汰")
    expect(first).not.toContain("Enter 查看关联请求")
    expect(first).toContain("费用口径 步骤总费用")

    // 返回列表，加载请求账一次再切回步骤账：请求进入本弹窗缓存后关联才可跳转。
    modal.app.mockInput.pressArrow("left")
    await modal.until(() => modal.app.captureCharFrame().includes("执行历史"))
    modal.app.mockInput.pressKey("s", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("request-model"))
    modal.app.mockInput.pressKey("s", { ctrl: true })
    await modal.until(() => modal.app.captureCharFrame().includes("step-model"))

    modal.keymap().dispatchCommand("dialog.select.submit")
    const linked = await modal.until(() => modal.app.captureCharFrame().includes("执行记录详情"))
    expect(linked).toContain("请求关联 req_abc")
    expect(linked).toContain("Enter 查看关联请求")

    modal.app.mockInput.pressEnter()
    const requestDetail = await modal.until(
      () =>
        modal.app.captureCharFrame().includes("request-model") &&
        modal.app.captureCharFrame().includes("执行记录详情"),
    )
    expect(requestDetail).toContain("结果 完成")
    expect(requestDetail).toContain("实报命中率 40%")
    expect(requestDetail).not.toContain("请求关联")
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
  // 到上限只说明客户端没继续加载；服务端保留策略不在会话分页响应里，不推断淘汰。
  expect(flightRecorderCapLabel("steps")).toBe("更早记录未加载")
  expect(flightRecorderCapLabel("requests")).toBe("更早请求未加载")
  expect(flightRecorderCap(2, 2, "cursor")).toBe("client")
  expect(flightRecorderCap(2, 2, undefined)).toBeUndefined()
  // 去重后超过客户端上限（本页有行被切掉）也属于“更早未加载”，与 next 无关
  expect(flightRecorderCap(4, 3, undefined)).toBe("client")
  expect(flightRecorderCap(127, 128, undefined)).toBeUndefined()
  expect(flightRecorderCap(128, 128, undefined)).toBeUndefined()
  expect(flightRecorderCap(128, 128, "cursor")).toBe("client")

  const prefix = { system: "baseline", tools: "unchanged", history: "rewrite", compressed: false } as const
  expect(prefixParts(prefix)).toEqual(["system 基线", "tools 未变", "history 重写"])
  expect(prefixParts({ ...prefix, compressed: true })).toContain("已压缩")
})

test("merge dedupes, sorts newest first and reports the pre-cap total", () => {
  const merged = mergeFlightRecorderRows(
    [row({ id: "a", time: 3 }), row({ id: "b", time: 1 })],
    [row({ id: "b", time: 1 }), row({ id: "c", time: 2 })],
    10,
  )
  expect(merged.rows.map((item) => item.id)).toEqual(["a", "c", "b"])
  expect(merged.total).toBe(3)

  const capped = mergeFlightRecorderRows(
    [],
    Array.from({ length: FLIGHT_RECORDER_MAX_ROWS.steps + 10 }, (_, index) => row({ id: `r${index}`, time: index })),
    FLIGHT_RECORDER_MAX_ROWS.steps,
  )
  expect(capped.rows.length).toBe(FLIGHT_RECORDER_MAX_ROWS.steps)
  // 切片前的总数必须保留，调用方据此判断本轮是否有行被客户端上限截掉
  expect(capped.total).toBe(FLIGHT_RECORDER_MAX_ROWS.steps + 10)
  expect(capped.rows[0]!.id).toBe(`r${FLIGHT_RECORDER_MAX_ROWS.steps + 9}`)
  // 客户端显示上限只约束 UI 累积；服务端实际保留多少由服务端策略决定
  expect(FLIGHT_RECORDER_MAX_ROWS.requests).toBe(150)
})
