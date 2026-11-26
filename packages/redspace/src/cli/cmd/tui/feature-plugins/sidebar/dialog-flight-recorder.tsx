import { TextAttributes } from "@opentui/core"
import type { FlightRecorderPage, FlightRecorderRow } from "@redcode-ai/sdk/v2"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import { useBindings } from "@tui/keymap"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"
import { errorMessage } from "@/util/error"
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"

// 261126 Red Flight Recorder V1：侧栏 Context 里按需打开的执行历史。
// 数据源有两个，口径不同不能混：steps 是旧账单步骤（缓存为归一化账单口径，
// 不是供应商原始证据），requests 是新的请求尝试记录（每会话服务端最多保留 128 条）。
// 打开前一律不发请求；分页只在用户显式触发时累积，并在客户端设行数上限。
export type FlightRecorderSource = "steps" | "requests"

export type FlightRecorderLoad = (input: {
  sessionID: string
  source: FlightRecorderSource
  before?: string
  limit?: number
}) => Promise<{ data?: FlightRecorderPage }>

export const FLIGHT_RECORDER_PAGE_SIZE = 30
// 两个来源的加载上限分开：旧账单步骤没有服务端保留窗口，请求尝试只保留 128 条。
// 到上限时必须明确说“更早的没加载/没保留”，不能把当前列表画成整个会话。
export const FLIGHT_RECORDER_MAX_ROWS: Record<FlightRecorderSource, number> = {
  steps: 150,
  requests: 128,
}

const OUTCOME_LABEL: Record<FlightRecorderRow["outcome"], string> = {
  booked: "账单",
  estimated: "估算",
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  unknown: "未知",
}

const PREFIX_LABEL: Record<NonNullable<FlightRecorderRow["prefix"]>["system"], string> = {
  baseline: "基线",
  unchanged: "未变",
  append: "追加",
  rewind: "回退",
  rewrite: "重写",
}

const moneyCny = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" })
const moneyUsd = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD" })

export function flightRecorderSourceLabel(source: FlightRecorderSource): string {
  return source === "steps" ? "账单步骤（旧历史）" : "请求尝试（新记录 · 最多 128 条）"
}

export function flightRecorderCapLabel(source: FlightRecorderSource): string {
  return source === "steps" ? "更早记录未加载" : "更早请求未保留"
}

export function outcomeLabel(outcome: FlightRecorderRow["outcome"]): string {
  return OUTCOME_LABEL[outcome] ?? "未知"
}

export function prefixTransitionLabel(value: NonNullable<FlightRecorderRow["prefix"]>["system"]): string {
  return PREFIX_LABEL[value] ?? "未知"
}

// 未采集与 0 是两件事：缺失的字段显示「未采集」，明确的 0 就显示 0。
export function formatRecordedNumber(value: number | undefined): string {
  return value === undefined ? "未采集" : value.toLocaleString("zh-CN")
}

export function formatRecordedCost(cost: number | undefined, currency: string | undefined): string {
  if (cost === undefined) return "未采集"
  if (currency === "CNY") return moneyCny.format(cost)
  if (currency === "USD") return moneyUsd.format(cost)
  const amount = cost.toLocaleString("zh-CN")
  return currency ? `${amount} ${currency}` : `${amount}（币种未采集）`
}

export function formatRecordedDuration(ms: number | undefined): string {
  if (ms === undefined) return "未采集"
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`
}

export function formatRecordedTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// input 已含缓存、output 已含推理（见契约）。estimated/unknown 不是实报，不生成命中率；
// 缺分母、input<=0、cacheRead<0 或 cacheRead>input 的异常值同理。
// booked 旧账允许 0：账面 0 是归一化时可能把缺报归零，不是供应商显式报告；
// 计入它才能看旧历史，也不会因为剔掉零样本把命中率抬高。
export function cacheHitPercent(row: Pick<FlightRecorderRow, "input" | "cacheRead" | "outcome">): number | undefined {
  if (row.outcome === "estimated" || row.outcome === "unknown") return undefined
  if (row.input === undefined || row.cacheRead === undefined) return undefined
  if (!Number.isFinite(row.input) || !Number.isFinite(row.cacheRead)) return undefined
  if (row.input <= 0 || row.cacheRead < 0 || row.cacheRead > row.input) return undefined
  return Math.round((row.cacheRead / row.input) * 1000) / 10
}

// 旧账的比率叫「账面命中率」，只有新请求记录才配叫「实报命中率」。
export function cacheHitLabel(row: Pick<FlightRecorderRow, "outcome">): string {
  return row.outcome === "booked" ? "账面命中率" : "实报命中率"
}

// cacheMiss 两个来源口径不同：requests 的 miss = input - cacheRead（已含写入），
// steps 的 miss 是 adjustedInput（不含写入）。标签必须写明，避免 read+write+miss
// 被叠加后又超过总输入。
export function cacheMissLabel(source: FlightRecorderSource): string {
  return source === "requests" ? "缓存未命中（含写入）" : "缓存未命中（不含写入）"
}

export function prefixParts(prefix: NonNullable<FlightRecorderRow["prefix"]>): string[] {
  const parts = [
    `system ${prefixTransitionLabel(prefix.system)}`,
    `tools ${prefixTransitionLabel(prefix.tools)}`,
    `history ${prefixTransitionLabel(prefix.history)}`,
  ]
  if (prefix.compressed) parts.push("已压缩")
  return parts
}

// 分页合并：按 id 去重、按时间最新的在前、总行数按来源上限封顶。
// 调用方只在用户触发时追加。
export function mergeFlightRecorderRows(
  current: readonly FlightRecorderRow[],
  incoming: readonly FlightRecorderRow[],
  maxRows: number,
): FlightRecorderRow[] {
  const seen = new Set(current.map((row) => row.id))
  const merged = [...current]
  for (const row of incoming) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  merged.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
  return merged.slice(0, maxRows)
}

export function SidebarFlightRecorder(props: { api: TuiPluginApi; sessionID: string; load: FlightRecorderLoad }) {
  const theme = () => props.api.theme.current
  const open = () => {
    props.api.ui.dialog.replace(() => <DialogFlightRecorder sessionID={props.sessionID} load={props.load} />)
  }
  useBindings(() => ({
    commands: [
      {
        name: "sidebar.flight_recorder.open",
        title: "Open execution history (flight recorder)",
        category: "Context",
        run: open,
      },
    ],
    bindings: props.api.tuiConfig.keybinds.gather("sidebar", ["sidebar.flight_recorder.open"]),
  }))
  return (
    <box onMouseDown={open}>
      <text fg={theme()?.textMuted}>▸ Flight Recorder</text>
    </box>
  )
}

export function DialogFlightRecorder(props: {
  sessionID: string
  load: FlightRecorderLoad
  pageSize?: number
  maxRows?: number
}) {
  const { theme } = useTheme()
  const [source, setSource] = createSignal<FlightRecorderSource>("steps")
  const [rows, setRows] = createSignal<FlightRecorderRow[]>([])
  const [next, setNext] = createSignal<string | undefined>()
  const [capped, setCapped] = createSignal(false)
  const [loading, setLoading] = createSignal<"initial" | "more" | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [selected, setSelected] = createSignal<FlightRecorderRow | undefined>()
  const pageSize = () => props.pageSize ?? FLIGHT_RECORDER_PAGE_SIZE
  const maxRows = () => props.maxRows ?? FLIGHT_RECORDER_MAX_ROWS[source()]

  // 每次换会话/换来源都推进 generation；迟到的旧响应回来时直接丢弃，
  // 避免 A 会话（或另一来源）的数据串到当前列表。
  let generation = 0
  const key = (sessionID = props.sessionID, value = source()) => `${sessionID}:${value}`
  // 非持久缓存：只活在这个对话框组件里，关闭即释放；不写 KV、不跨会话复用。
  const cache = new Map<string, { rows: FlightRecorderRow[]; next?: string; capped: boolean }>()

  async function loadFirst() {
    const current = ++generation
    const currentKey = key()
    setLoading("initial")
    setError(undefined)
    try {
      const result = await props.load({ sessionID: props.sessionID, source: source(), limit: pageSize() })
      if (current !== generation) return
      if (!result.data) throw new Error("空响应")
      const limit = maxRows()
      const merged = mergeFlightRecorderRows([], result.data.items, limit)
      // 只有真的还有下一页（或 requests 的 128 保留窗口已满）才算 capped；
      // steps 恰好落在上限且没有 next 时，服务端已证明这是完整列表。
      const capped = merged.length >= limit && (!!result.data.next || source() === "requests")
      const page = { rows: merged, next: capped ? undefined : result.data.next, capped }
      cache.set(currentKey, page)
      setRows(page.rows)
      setNext(page.next)
      setCapped(page.capped)
    } catch (cause) {
      if (current !== generation) return
      setRows([])
      setNext(undefined)
      setCapped(false)
      setError(errorMessage(cause))
    } finally {
      if (current === generation) setLoading(undefined)
    }
  }

  async function loadMore() {
    const before = next()
    if (!before || loading() || capped()) return
    const current = generation
    setLoading("more")
    setError(undefined)
    try {
      const result = await props.load({
        sessionID: props.sessionID,
        source: source(),
        before,
        limit: pageSize(),
      })
      if (current !== generation) return
      if (!result.data) throw new Error("空响应")
      const limit = maxRows()
      const seen = new Set(rows().map((item) => item.id))
      const hasFresh = result.data.items.some((item) => !seen.has(item.id))
      const merged = mergeFlightRecorderRows(rows(), result.data.items, limit)
      // 达到上限后仍保留 cursor 信息没有意义：不再翻页，但 capped 必须让界面
      // 明确说明“更早的没加载”，不能画成整个会话。
      const capped = merged.length >= limit && (!!result.data.next || source() === "requests")
      const page = {
        rows: merged,
        // 服务端重复返回同一页时（fresh 为空）也要停住 cursor，避免同一页反复请求。
        next: capped || !hasFresh || !result.data.next || result.data.next === before ? undefined : result.data.next,
        capped,
      }
      cache.set(key(), page)
      setRows(page.rows)
      setNext(page.next)
      setCapped(page.capped)
    } catch (cause) {
      if (current !== generation) return
      // 已有行留着；错误行挂在列表末尾，Enter 或重试动作都用同一个 before 再试。
      setError(errorMessage(cause))
    } finally {
      if (current === generation) setLoading(undefined)
    }
  }

  function switchSource() {
    const target: FlightRecorderSource = source() === "steps" ? "requests" : "steps"
    generation++
    setSource(target)
    setSelected(undefined)
    setError(undefined)
    setLoading(undefined)
    setCapped(false)
    const cached = cache.get(key(props.sessionID, target))
    if (cached) {
      setRows(cached.rows)
      setNext(cached.next)
      setCapped(cached.capped)
      return
    }
    setRows([])
    setNext(undefined)
    void loadFirst()
  }

  function retry() {
    if (loading()) return
    if (rows().length === 0) return void loadFirst()
    return void loadMore()
  }

  onMount(() => {
    void loadFirst()
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        generation++
        cache.clear()
        setRows([])
        setNext(undefined)
        setCapped(false)
        setError(undefined)
        setLoading(undefined)
        setSelected(undefined)
        void loadFirst()
      },
      { defer: true },
    ),
  )

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list: DialogSelectOption<string>[] = rows().map((row) => {
      const rate = cacheHitPercent(row)
      return {
        title: `${formatRecordedTime(row.time)}  ${row.modelID}`,
        value: row.id,
        description: [outcomeLabel(row.outcome), row.summary ? "摘要" : undefined].filter(Boolean).join(" · "),
        // 命中率放行首 gutter（不参与标题截断）：窄终端下模型和结果可能被裁，
        // 但低点数字必须仍然一眼可见。没有可算的命中率就不占位。
        gutter: rate === undefined ? undefined : () => <text fg={theme.textMuted}>{`${rate}%`}</text>,
        footer:
          row.cost !== undefined
            ? formatRecordedCost(row.cost, row.currency)
            : row.durationMs !== undefined
              ? formatRecordedDuration(row.durationMs)
              : undefined,
        onSelect: () => {
          setSelected(row)
        },
      }
    })
    if (list.length === 0) {
      if (loading() === "initial") {
        return [{ title: "加载中…", value: "__flight:loading", readOnly: true }]
      }
      if (error()) {
        return [
          {
            title: `加载失败：${error()}`,
            value: "__flight:retry",
            description: "Enter 重试",
            onSelect: retry,
          },
        ]
      }
      return [
        {
          title: "没有执行记录",
          value: "__flight:empty",
          description: source() === "steps" ? "此会话没有旧账单步骤" : "此会话还没有请求尝试记录",
          readOnly: true,
        },
      ]
    }
    if (error()) {
      list.push({
        title: `加载更早失败：${error()}`,
        value: "__flight:more-retry",
        description: "Enter 重试",
        onSelect: retry,
      })
    }
    return list
  })

  const footerHints = createMemo(() => {
    const hints: { title: string; label: string }[] = []
    if (loading() === "more") hints.push({ title: "加载中", label: "…" })
    else if (capped()) {
      // 到上限必须明确还有更早的没进来，避免看起来像整个会话都已列出。
      hints.push({
        title: "已到上限",
        label: flightRecorderCapLabel(source()),
      })
    } else if (rows().length > 0 && !next()) hints.push({ title: "已到", label: "最早" })
    hints.push({ title: "查看", label: "Enter" })
    return hints
  })

  return (
    <Show
      when={selected()}
      fallback={
        <DialogSelect
          title={`执行历史 · ${flightRecorderSourceLabel(source())}`}
          placeholder="按模型或结果过滤"
          options={options()}
          selectedKey={(option) => option.value}
          emptyContent="没有匹配记录"
          footerHints={footerHints()}
          actions={[
            {
              command: "sidebar.flight_recorder.source",
              title: "切换来源",
              onTrigger: () => switchSource(),
            },
            {
              command: "sidebar.flight_recorder.more",
              title: "加载更早",
              disabled: !next() || loading() !== undefined || capped(),
              onTrigger: () => void loadMore(),
            },
            {
              command: "sidebar.flight_recorder.retry",
              title: "重试",
              disabled: !error(),
              onTrigger: () => retry(),
            },
          ]}
          bindings={[
            { key: "ctrl+s", cmd: "sidebar.flight_recorder.source", desc: "切换来源", group: "Dialog" },
            { key: "ctrl+l", cmd: "sidebar.flight_recorder.more", desc: "加载更早", group: "Dialog" },
            { key: "ctrl+r", cmd: "sidebar.flight_recorder.retry", desc: "重试", group: "Dialog" },
          ]}
        />
      }
    >
      {(row) => (
        <FlightRecorderDetail
          row={row()}
          source={source()}
          onBack={() => {
            setSelected(undefined)
          }}
        />
      )}
    </Show>
  )
}

function FlightRecorderDetail(props: { row: FlightRecorderRow; source: FlightRecorderSource; onBack: () => void }) {
  const { theme } = useTheme()
  const row = () => props.row
  const hitRate = createMemo(() => cacheHitPercent(row()))
  const cacheValues = createMemo(() =>
    [
      { label: "缓存命中", value: row().cacheRead },
      { label: cacheMissLabel(props.source), value: row().cacheMiss },
      { label: "缓存写入", value: row().cacheWrite },
    ].filter((item) => item.value !== undefined),
  )
  useBindings(() => ({
    commands: [
      {
        name: "sidebar.flight_recorder.back",
        title: "Back to execution history",
        category: "Context",
        run: props.onBack,
      },
    ],
    bindings: [
      { key: "left", cmd: "sidebar.flight_recorder.back", desc: "返回列表", group: "Dialog" },
      { key: "backspace", cmd: "sidebar.flight_recorder.back", desc: "返回列表", group: "Dialog" },
    ],
  }))

  return (
    <box flexDirection="column" gap={0} paddingLeft={4} paddingRight={4} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          执行记录详情
        </text>
        <text fg={theme.textMuted} onMouseUp={props.onBack}>
          ← 返回
        </text>
      </box>
      <text fg={theme.textMuted}>
        {formatRecordedTime(row().time)} · {row().providerID}/{row().modelID}
      </text>
      <text fg={theme.textMuted}>
        结果 {outcomeLabel(row().outcome)}
        <Show when={row().summary}> · 摘要消息</Show>
      </text>
      <Show when={row().outcome === "estimated"}>
        <text fg={theme.warning}>数值口径 估算（非实报）</text>
      </Show>
      <Show when={props.source === "steps" || row().outcome === "booked"}>
        <text fg={theme.textMuted}>缓存口径 账单归一化（记账 0 可能来自缺报归零，不代表供应商显式 0）</text>
      </Show>
      <text fg={theme.textMuted}>
        输入（含缓存） <span style={{ fg: theme.text }}>{formatRecordedNumber(row().input)}</span>
      </text>
      <text fg={theme.textMuted}>
        输出（含推理） <span style={{ fg: theme.text }}>{formatRecordedNumber(row().output)}</span>
      </text>
      <Show when={cacheValues().length > 0} fallback={<text fg={theme.textMuted}>缓存 未采集</text>}>
        <For each={cacheValues()}>
          {(item) => (
            <text fg={theme.textMuted}>
              {item.label} <span style={{ fg: theme.text }}>{formatRecordedNumber(item.value)}</span>
            </text>
          )}
        </For>
        <Show when={hitRate() !== undefined}>
          <text fg={theme.textMuted}>
            {cacheHitLabel(row())} <span style={{ fg: theme.text }}>{hitRate()}%</span>
          </text>
        </Show>
      </Show>
      <text fg={theme.textMuted}>
        费用 <span style={{ fg: theme.text }}>{formatRecordedCost(row().cost, row().currency)}</span>
      </text>
      <Show when={row().durationMs !== undefined}>
        <text fg={theme.textMuted}>
          耗时 <span style={{ fg: theme.text }}>{formatRecordedDuration(row().durationMs)}</span>
        </text>
      </Show>
      <Show when={row().firstEventMs !== undefined}>
        <text fg={theme.textMuted}>
          首事件 <span style={{ fg: theme.text }}>{formatRecordedDuration(row().firstEventMs)}</span>
        </text>
      </Show>
      <Show when={row().prefix}>
        {(prefix) => (
          <text fg={theme.textMuted}>
            同模型前缀 <span style={{ fg: theme.text }}>{prefixParts(prefix()).join(" · ")}</span>
          </text>
        )}
      </Show>
      <text fg={theme.textMuted}>← / Backspace 返回列表</text>
    </box>
  )
}
