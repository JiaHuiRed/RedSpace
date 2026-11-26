import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type {
  CacheStats,
  CostBucket,
  Coverage,
  GlobalPage,
  GlobalRow,
  GlobalSummary,
  RequestSummary,
  UsageStats,
} from "@/session/flight-recorder"
import { errorMessage } from "@/util/error"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { InternalTuiPlugin } from "../../plugin/internal"
import {
  cacheHitPercent,
  FlightRecorderDetail,
  flightRecorderSourceLabel,
  formatRecordedCost,
  formatRecordedDuration,
  formatRecordedNumber,
  formatRecordedTime,
  outcomeLabel,
  recordedRequestID,
  type FlightRecorderSource,
} from "../sidebar/dialog-flight-recorder"

// 261126 Red FR-04 全局执行历史：独立于会话的常驻命令，只从命令面板进入。
// 作用域由服务端实例解析（当前服务器项目/工作区），客户端不传项目参数；
// 打开后才查询，关闭即释放，不订阅事件、不轮询。
export const FLIGHT_RECORDER_GLOBAL_COMMAND = "flight_recorder.global.open"
export const FLIGHT_RECORDER_GLOBAL_MORE = "flight_recorder.global.more"
export const FLIGHT_RECORDER_GLOBAL_REFRESH = "flight_recorder.global.refresh"
export const FLIGHT_RECORDER_GLOBAL_PAGE_SIZE = 30
// 全局列表同样有界：到上限只能说“更早的没加载”，不能画成完整历史。
export const FLIGHT_RECORDER_GLOBAL_MAX_ROWS = 150

export type FlightRecorderGlobalQuery = {
  from?: number
  to?: number
  providerID?: string
  modelID?: string
  sessionID?: string
  workspaceID?: string
}

export type FlightRecorderGlobalLoad = {
  summary: (query: FlightRecorderGlobalQuery) => Promise<{ data?: GlobalSummary }>
  rows: (
    input: FlightRecorderGlobalQuery & { source: FlightRecorderSource; before?: string; limit?: number },
  ) => Promise<{ data?: GlobalPage }>
}

export type FlightRecorderGlobalTime =
  | { key: "all" }
  | { key: "today" }
  | { key: "7d" }
  | { key: "30d" }
  | { key: "day"; day: string }

const DAY_MS = 86_400_000
const pad2 = (value: number) => String(value).padStart(2, "0")

export function flightRecorderLocalDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

const startOfLocalDay = (time: number) => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function flightRecorderTimeBounds(
  time: FlightRecorderGlobalTime,
  now: number,
): { from?: number; to?: number; label: string } {
  if (time.key === "all") return { label: "全部时间" }
  if (time.key === "today") return { from: startOfLocalDay(now), label: "今天" }
  if (time.key === "7d") return { from: now - 7 * DAY_MS, label: "最近 7 天" }
  if (time.key === "30d") return { from: now - 30 * DAY_MS, label: "最近 30 天" }
  const [year, month, day] = time.day.split("-").map(Number)
  if (!year || !month || !day) return { label: time.day }
  return {
    from: new Date(year, month - 1, day).getTime(),
    to: new Date(year, month - 1, day + 1).getTime(),
    label: time.day,
  }
}

export function nextFlightRecorderTime(time: FlightRecorderGlobalTime): FlightRecorderGlobalTime {
  if (time.key === "all") return { key: "today" }
  if (time.key === "today") return { key: "7d" }
  if (time.key === "7d") return { key: "30d" }
  return { key: "all" }
}

const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`

// 服务端只把有效样本计入 hitRate；缺报/无效分开列，缺报不是 0。
export function formatGlobalHitRate(cache: CacheStats): string {
  return cache.hitRate === undefined ? "无有效样本" : percent(cache.hitRate)
}

export function formatGlobalCacheSamples(cache: CacheStats): string {
  const parts = [`有效样本 ${formatRecordedNumber(cache.samples)}`]
  if (cache.excluded.invalid) parts.push(`无效 ${formatRecordedNumber(cache.excluded.invalid)}`)
  if (cache.excluded.incomplete) parts.push(`缺报 ${formatRecordedNumber(cache.excluded.incomplete)}`)
  return parts.join(" · ")
}

// 费用只按服务端记下的币种分桶，不换算；缺报单独计数，不当成 0。
export function formatGlobalCost(cost: readonly CostBucket[]): string {
  if (cost.length === 0) return "无记账行（缺报不等于 0）"
  return cost
    .map((bucket) => {
      const unit = bucket.currency ?? undefined
      const parts: string[] = []
      if (bucket.samples > 0) {
        // booked 为 0 时不能声称“0 已记账”：纯估算桶没有 booked 样本。
        if (bucket.booked !== 0) parts.push(`${formatRecordedCost(bucket.booked, unit)} 已记账`)
        // 纯估算桶即使估算为 0 也要显示，不能省略成只有缺报/无记录。
        if (bucket.estimated !== 0 || bucket.booked === 0)
          parts.push(`${formatRecordedCost(bucket.estimated, unit)} 估算`)
      }
      if (bucket.missing > 0) parts.push(`缺报 ${formatRecordedNumber(bucket.missing)}`)
      return parts.join(" · ") || "无记录"
    })
    .join(" · ")
}

// coverage 是服务端实际检查到的窗口，不是历史起点；truncated 时窗口外未知。
export function formatGlobalCoverage(coverage: Coverage): string {
  const range =
    coverage.from === undefined || coverage.to === undefined
      ? "未检查到记录"
      : `${formatRecordedTime(coverage.from)}–${formatRecordedTime(coverage.to)}`
  return `${range} · 扫描 ${formatRecordedNumber(coverage.scanned)} 行 · ${coverage.truncated ? "已截断（更旧未检查）" : "完整"}`
}

export function formatGlobalLatency(latency: RequestSummary["latency"]): string {
  if (latency.samples === 0) return "未采集"
  const duration = latency.durationMs
  const first = latency.firstEventMs
  return [
    `P50 ${formatRecordedDuration(duration.p50)}`,
    `P95 ${formatRecordedDuration(duration.p95)}`,
    `最大 ${formatRecordedDuration(duration.max)}`,
    first.p50 === undefined ? undefined : `首事件 P50 ${formatRecordedDuration(first.p50)}`,
    `${formatRecordedNumber(latency.samples)} 样本`,
  ]
    .filter((item): item is string => item !== undefined)
    .join(" · ")
}

const usageText = (usage: UsageStats) =>
  `输入 ${formatRecordedNumber(usage.input)} · 输出 ${formatRecordedNumber(usage.output)} · 读 ${formatRecordedNumber(usage.cacheRead)} · 写 ${formatRecordedNumber(usage.cacheWrite)} · 未命中 ${formatRecordedNumber(usage.cacheMiss)}`

// 容量策略由服务端提供，客户端不把 128/100000 之类的当前值写死成结论。
// 只展示响应里实际给出的字段；没有字段时说“未提供（默认/未知）”。
export function formatRetentionPolicy(retention: GlobalSummary["retention"] | undefined): string {
  if (retention === undefined) return "服务端未提供（默认/未知）"
  const values = retention as Record<string, unknown>
  const parts: string[] = []
  if (typeof values.totalRequests === "number")
    parts.push(`全局 ${formatRecordedNumber(values.totalRequests)} 条`)
  if (typeof values.requestsPerSession === "number")
    parts.push(`每会话 ${formatRecordedNumber(values.requestsPerSession)} 条`)
  if (typeof values.retentionMs === "number") parts.push(`时间保留 ${retentionAge(values.retentionMs)}`)
  if (parts.length > 0) return parts.join(" · ")
  // 后端将来若用别的字段名，也只原样展示数值，不冒充某个具体策略名。
  const numeric = Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  if (numeric.length > 0)
    return numeric.map(([key, value]) => `${key} ${formatRecordedNumber(value)}`).join(" · ")
  return "服务端未提供（默认/未知）"
}

function retentionAge(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`
  return `${Math.round(ms / 1000)} 秒`
}

// 两本账分开列，不相加；请求按每次可观察尝试计数，不推断重试或账单关联。
function summarySections(data: GlobalSummary) {
  const steps = data.steps
  const requests = data.requests
  const sections: { category: string; title: string; description: string }[] = [
    {
      category: "账本 A · 账单步骤",
      title: `${formatRecordedNumber(steps.samples)} 条`,
      description: `主 ${steps.sessions.main} / 子 ${steps.sessions.sub} 会话 · 账单 ${steps.outcomes.booked} · 估算 ${steps.outcomes.estimated}`,
    },
    { category: "账本 A · 账单步骤", title: "用量", description: usageText(steps.usage) },
    {
      category: "账本 A · 账单步骤",
      title: "账面命中率",
      description: `${formatGlobalHitRate(steps.usage.cache)} · ${formatGlobalCacheSamples(steps.usage.cache)}`,
    },
    { category: "账本 A · 账单步骤", title: "费用（按币种分列）", description: formatGlobalCost(steps.cost) },
    {
      category: "账本 A · 账单步骤",
      title: "归属",
      description: `主 ${formatRecordedNumber(data.ownership.steps.main.input)} 输入 · 子 ${formatRecordedNumber(data.ownership.steps.sub.input)} 输入`,
    },
    {
      category: "账本 B · 请求尝试",
      title: `${formatRecordedNumber(requests.samples)} 条`,
      description: `主 ${requests.sessions.main} / 子 ${requests.sessions.sub} 会话`,
    },
    { category: "账本 B · 请求尝试", title: "用量", description: usageText(requests.usage) },
    {
      category: "账本 B · 请求尝试",
      title: "实报命中率",
      description: `${formatGlobalHitRate(requests.usage.cache)} · ${formatGlobalCacheSamples(requests.usage.cache)}`,
    },
    {
      category: "账本 B · 请求尝试",
      title: "尝试结果",
      description: `完成 ${requests.outcomes.completed} · 失败 ${requests.outcomes.failed} · 取消 ${requests.outcomes.cancelled} · 未知 ${requests.outcomes.unknown}（每次尝试单独计数，不推断重试）`,
    },
    { category: "账本 B · 请求尝试", title: "延迟", description: formatGlobalLatency(requests.latency) },
    {
      category: "账本 B · 请求尝试",
      title: "归属",
      description: `主 ${formatRecordedNumber(data.ownership.requests.main.input)} 输入 · 子 ${formatRecordedNumber(data.ownership.requests.sub.input)} 输入`,
    },
    { category: "覆盖与限制", title: "覆盖 · 账单", description: formatGlobalCoverage(data.coverage.steps) },
    { category: "覆盖与限制", title: "覆盖 · 请求", description: formatGlobalCoverage(data.coverage.requests) },
  ]
  if (data.truncated)
    sections.push({
      category: "覆盖与限制",
      title: "扫描预算已满",
      description: `上限 ${data.limits.scan} 行；统计只覆盖窗口内，更旧记录未检查`,
    })
  if (data.breakdownsTruncated)
    sections.push({
      category: "覆盖与限制",
      title: "分组已截断",
      description: `模型/工作区最多 ${data.limits.groups} 个 · 日趋势最多 ${data.limits.trendDays} 天`,
    })
  sections.push(
    {
      category: "口径",
      title: "双账本",
      description: "账单与请求分开统计，不相加；缺报不是 0，费用不换算币种",
    },
    {
      category: "口径",
      title: "关联",
      description: "不推断重试；步骤账的 requestID 只在服务端投影时显示，缺失即未关联；费用只算步骤总账",
    },
    {
      category: "口径",
      title: "保留",
      description: `服务端策略 ${formatRetentionPolicy(data.retention)}；当前列表不是完整历史`,
    },
  )
  return sections
}

// 全局行按 (sessionID, id) 去重：不同会话的 part id 不需要跨会话比对。
export function mergeFlightRecorderGlobalRows(
  current: readonly GlobalRow[],
  incoming: readonly GlobalRow[],
  maxRows: number,
): { rows: GlobalRow[]; total: number } {
  const key = (row: GlobalRow) => `${row.sessionID}:${row.id}`
  const seen = new Set(current.map(key))
  const merged = [...current]
  for (const row of incoming) {
    if (seen.has(key(row))) continue
    seen.add(key(row))
    merged.push(row)
  }
  merged.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
  return { rows: merged.slice(0, maxRows), total: merged.length }
}

export function DialogFlightRecorderGlobal(props: {
  load: FlightRecorderGlobalLoad
  directory?: string
  openSession?: (sessionID: string) => void
  pageSize?: number
  maxRows?: number
  now?: () => number
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const now = () => props.now?.() ?? Date.now()
  const pageSize = () => props.pageSize ?? FLIGHT_RECORDER_GLOBAL_PAGE_SIZE
  const maxRows = () => props.maxRows ?? FLIGHT_RECORDER_GLOBAL_MAX_ROWS

  const [source, setSource] = createSignal<FlightRecorderSource>("steps")
  const [time, setTime] = createSignal<FlightRecorderGlobalTime>({ key: "all" })
  const [model, setModel] = createSignal<{ providerID: string; modelID: string } | undefined>()
  const [workspaceFilter, setWorkspaceFilter] = createSignal<string | undefined>()
  const [sessionFilter, setSessionFilter] = createSignal<string | undefined>()
  const [summary, setSummary] = createSignal<GlobalSummary | undefined>()
  const [summaryLoading, setSummaryLoading] = createSignal(false)
  const [summaryError, setSummaryError] = createSignal<string | undefined>()
  const [modelCatalog, setModelCatalog] = createSignal<GlobalSummary["models"]>([])
  const [workspaceCatalog, setWorkspaceCatalog] = createSignal<GlobalSummary["workspaces"]>([])
  const [rows, setRows] = createSignal<GlobalRow[]>([])
  const [next, setNext] = createSignal<string | undefined>()
  const [capped, setCapped] = createSignal(false)
  const [rowsLoading, setRowsLoading] = createSignal<"initial" | "more" | undefined>()
  const [rowsError, setRowsError] = createSignal<string | undefined>()
  const [selected, setSelected] = createSignal<GlobalRow | undefined>()
  const [panel, setPanel] = createSignal<"model" | "workspace" | "session" | undefined>()

  // 每次筛选/来源变化推进 generation；迟到的旧响应不能污染当前视图。
  let summaryGeneration = 0
  let rowsGeneration = 0

  const query = createMemo<FlightRecorderGlobalQuery>(() => {
    const bounds = flightRecorderTimeBounds(time(), now())
    const selectedModel = model()
    const selectedWorkspace = workspaceFilter()
    const selectedSession = sessionFilter()
    return {
      ...(bounds.from === undefined ? {} : { from: bounds.from }),
      ...(bounds.to === undefined ? {} : { to: bounds.to }),
      ...(selectedModel === undefined
        ? {}
        : { providerID: selectedModel.providerID, modelID: selectedModel.modelID }),
      ...(selectedWorkspace === undefined ? {} : { workspaceID: selectedWorkspace }),
      ...(selectedSession === undefined ? {} : { sessionID: selectedSession }),
    }
  })

  async function loadSummary() {
    const current = ++summaryGeneration
    // 筛选/刷新开始后旧摘要不再属于当前条件；清空后由加载/失败状态接管。
    setSummary(undefined)
    setSummaryLoading(true)
    setSummaryError(undefined)
    try {
      const result = await props.load.summary(query())
      if (current !== summaryGeneration) return
      if (!result.data) throw new Error("空响应")
      setSummary(result.data)
      // 分组筛选的候选保留最近一次未按模型/工作区收窄的摘要，选中后仍能换到别的分组。
      if (model() === undefined && workspaceFilter() === undefined) {
        setModelCatalog(result.data.models)
        setWorkspaceCatalog(result.data.workspaces)
      }
    } catch (cause) {
      if (current !== summaryGeneration) return
      setSummaryError(errorMessage(cause))
    } finally {
      if (current === summaryGeneration) setSummaryLoading(false)
    }
  }

  async function loadFirstRows() {
    const current = ++rowsGeneration
    setRowsLoading("initial")
    setRowsError(undefined)
    try {
      const result = await props.load.rows({ ...query(), source: source(), limit: pageSize() })
      if (current !== rowsGeneration) return
      if (!result.data) throw new Error("空响应")
      const limit = maxRows()
      const merged = mergeFlightRecorderGlobalRows([], result.data.items, limit)
      // 有 next 但客户端先到上限：更早的没加载；没有 next 且达到上限同理。
      const cap = merged.total > limit || (result.data.next !== undefined && merged.rows.length >= limit)
      setRows(merged.rows)
      setNext(cap ? undefined : result.data.next)
      setCapped(cap)
    } catch (cause) {
      if (current !== rowsGeneration) return
      setRows([])
      setNext(undefined)
      setCapped(false)
      setRowsError(errorMessage(cause))
    } finally {
      if (current === rowsGeneration) setRowsLoading(undefined)
    }
  }

  async function loadMore() {
    const before = next()
    if (!before || rowsLoading() !== undefined || capped()) return
    const current = rowsGeneration
    setRowsLoading("more")
    setRowsError(undefined)
    try {
      const result = await props.load.rows({ ...query(), source: source(), before, limit: pageSize() })
      if (current !== rowsGeneration) return
      if (!result.data) throw new Error("空响应")
      const limit = maxRows()
      const merged = mergeFlightRecorderGlobalRows(rows(), result.data.items, limit)
      const cap = merged.total > limit || (result.data.next !== undefined && merged.rows.length >= limit)
      setRows(merged.rows)
      // 空页也可能只是这一段没有匹配，next 指向更早的匹配；只有游标缺失/重复/到上限才停。
      setNext(
        cap || result.data.next === undefined || result.data.next === before ? undefined : result.data.next,
      )
      setCapped(cap)
    } catch (cause) {
      if (current !== rowsGeneration) return
      setRowsError(errorMessage(cause))
    } finally {
      if (current === rowsGeneration) setRowsLoading(undefined)
    }
  }

  function reload() {
    setRows([])
    setNext(undefined)
    setCapped(false)
    setRowsError(undefined)
    setSelected(undefined)
    void loadSummary()
    void loadFirstRows()
  }

  function switchSource() {
    setSource(source() === "steps" ? "requests" : "steps")
    setRows([])
    setNext(undefined)
    setCapped(false)
    setRowsError(undefined)
    void loadFirstRows()
  }

  function cycleTime() {
    setTime(nextFlightRecorderTime(time()))
    reload()
  }

  function closePanel() {
    setPanel(undefined)
    dialog.setSize("xlarge")
  }

  function applyModel(entry: { providerID: string; modelID: string }) {
    setModel({ providerID: entry.providerID, modelID: entry.modelID })
    closePanel()
    reload()
  }

  function applyWorkspace(workspaceID: string) {
    setWorkspaceFilter(workspaceID)
    closePanel()
    reload()
  }

  function applyDay(day: string) {
    setTime({ key: "day", day })
    closePanel()
    reload()
  }

  function applySession(value: string) {
    const sessionID = value.trim()
    setSessionFilter(sessionID || undefined)
    closePanel()
    reload()
  }

  function clearFilters() {
    setTime({ key: "all" })
    setModel(undefined)
    setWorkspaceFilter(undefined)
    setSessionFilter(undefined)
    closePanel()
    reload()
  }

  function retryRows() {
    // 失败发生在更早一页时 rows() 可能还是空；next() 仍指向失败请求的游标，
    // 必须沿用它重试，不能退回首页。
    if (next() !== undefined && !capped()) return void loadMore()
    return void loadFirstRows()
  }

  onMount(() => {
    dialog.setSize("xlarge")
    void loadSummary()
    void loadFirstRows()
  })

  const gutterOf = (cache: CacheStats) =>
    cache.hitRate === undefined
      ? undefined
      : () => <text fg={theme.textMuted}>{formatGlobalHitRate(cache)}</text>
  const rowGutter = (row: Pick<GlobalRow, "input" | "cacheRead" | "outcome">) => {
    const rate = cacheHitPercent(row)
    return rate === undefined ? undefined : () => <text fg={theme.textMuted}>{`${rate}%`}</text>
  }
  const groupGutter = (entry: { steps: GlobalSummary["steps"]; requests: GlobalSummary["requests"] }) =>
    gutterOf(source() === "steps" ? entry.steps.usage.cache : entry.requests.usage.cache)

  const mainOptions = createMemo<DialogSelectOption<string>[]>(() => {
    const list: DialogSelectOption<string>[] = []
    const bounds = flightRecorderTimeBounds(time(), now())
    const selectedModel = model()
    const selectedWorkspace = workspaceFilter()
    const selectedSession = sessionFilter()

    list.push(
      {
        category: "范围",
        title: "作用域 · 当前服务器项目/工作区",
        value: "scope:server",
        description: "由服务端实例解析，客户端不传项目参数",
        readOnly: true,
      },
      ...(props.directory === undefined
        ? []
        : [
            {
              category: "范围",
              title: `目录 ${props.directory}`,
              value: "scope:directory",
              readOnly: true,
            } as DialogSelectOption<string>,
          ]),
      {
        category: "筛选",
        title: `来源 · ${flightRecorderSourceLabel(source())}`,
        value: "filter:source",
        description: "切换两本账（分开统计，不相加）",
        onSelect: switchSource,
      },
      {
        category: "筛选",
        title: `时间 · ${bounds.label}`,
        value: "filter:time",
        description: "全部 / 今天 / 最近 7 天 / 最近 30 天",
        onSelect: cycleTime,
      },
      {
        category: "筛选",
        title: `模型 · ${selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : "全部"}`,
        value: "filter:model",
        description: "Enter 选择（来自当前摘要分组）",
        onSelect: () => setPanel("model"),
      },
      {
        category: "筛选",
        title: `工作区 · ${selectedWorkspace ?? "全部"}`,
        value: "filter:workspace",
        description: "Enter 选择（来自当前摘要分组）",
        onSelect: () => setPanel("workspace"),
      },
      {
        category: "筛选",
        title: `会话 · ${selectedSession ?? "全部"}`,
        value: "filter:session",
        description: "Enter 输入会话 ID",
        onSelect: () => setPanel("session"),
      },
    )
    if (selectedModel || selectedWorkspace || selectedSession || time().key !== "all") {
      list.push({
        category: "筛选",
        title: "清除筛选",
        value: "filter:clear",
        description: "回到全部时间 / 模型 / 工作区 / 会话",
        onSelect: clearFilters,
      })
    }

    const data = summary()
    if (summaryLoading() && data === undefined)
      list.push({ category: "摘要", title: "摘要加载中…", value: "summary:loading", readOnly: true })
    if (summaryError())
      list.push({
        category: "摘要",
        title: `摘要加载失败：${summaryError()}`,
        value: "summary:error",
        description: "Enter 重试",
        onSelect: () => void loadSummary(),
      })
    if (data) {
      summarySections(data).forEach((section, index) => {
        list.push({
          category: section.category,
          title: section.title,
          description: section.description,
          value: `summary:${index}`,
          readOnly: true,
        })
      })
      if (data.steps.samples === 0 && data.requests.samples === 0)
        list.push({ category: "摘要", title: "当前筛选没有记录", value: "summary:empty", readOnly: true })
      data.models.forEach((entry) =>
        list.push({
          category: "按模型",
          title: `${entry.providerID}/${entry.modelID}`,
          value: `group:model:${entry.providerID}/${entry.modelID}`,
          description: `账单 ${entry.steps.samples} · 请求 ${entry.requests.samples}`,
          gutter: groupGutter(entry),
          onSelect: () => applyModel(entry),
        }),
      )
      data.workspaces.forEach((entry) => {
        const workspaceID = entry.workspaceID
        list.push({
          category: "按工作区",
          title: workspaceID ?? "（无工作区）",
          value: `group:workspace:${workspaceID ?? "__none"}`,
          description:
            workspaceID === undefined
              ? "无工作区记录不支持筛选"
              : `账单 ${entry.steps.samples} · 请求 ${entry.requests.samples}`,
          gutter: workspaceID === undefined ? undefined : groupGutter(entry),
          readOnly: workspaceID === undefined,
          ...(workspaceID === undefined ? {} : { onSelect: () => applyWorkspace(workspaceID) }),
        })
      })
      ;[...data.daily].reverse().forEach((entry) =>
        list.push({
          category: "按日期",
          title: entry.day,
          value: `group:day:${entry.day}`,
          description: `账单 ${entry.steps.samples} · 请求 ${entry.requests.samples}`,
          gutter: groupGutter(entry),
          onSelect: () => applyDay(entry.day),
        }),
      )
    }

    const recordCategory = `记录 · ${flightRecorderSourceLabel(source())}`
    rows().forEach((row) =>
      list.push({
        category: recordCategory,
        title: `${formatRecordedTime(row.time)}  ${row.modelID}`,
        value: `row:${row.sessionID}:${row.id}`,
        description: [
          outcomeLabel(row.outcome),
          row.summary ? "摘要" : undefined,
          `会话 …${row.sessionID.slice(-6)}`,
          row.sub ? "子代理" : undefined,
          // 步骤账才有服务端投影的 requestID；缺失时明确写未关联，不按位置猜。
          source() === "steps"
            ? recordedRequestID(row) === undefined
              ? "未关联请求"
              : "已关联请求"
            : undefined,
        ]
          .filter((item): item is string => item !== undefined)
          .join(" · "),
        gutter: rowGutter(row),
        footer:
          row.cost !== undefined
            ? formatRecordedCost(row.cost, row.currency)
            : row.durationMs !== undefined
              ? formatRecordedDuration(row.durationMs)
              : undefined,
        onSelect: () => {
          setPanel(undefined)
          setSelected(row)
        },
      }),
    )
    if (rowsLoading() === "initial" && rows().length === 0)
      list.push({ category: "记录", title: "加载中…", value: "rows:loading", readOnly: true })
    if (rowsLoading() === "more")
      list.push({ category: "记录", title: "加载更早…", value: "rows:more-loading", readOnly: true })
    if (rowsError())
      list.push({
        category: "记录",
        title: `加载失败：${rowsError()}`,
        value: "rows:error",
        description: "Enter 重试",
        onSelect: () => void retryRows(),
      })
    if (
      rowsLoading() === undefined &&
      rowsError() === undefined &&
      rows().length === 0 &&
      next() === undefined
    )
      list.push({
        category: "记录",
        title: "没有记录",
        value: "rows:empty",
        description: source() === "steps" ? "当前筛选没有旧账单步骤" : "当前筛选没有请求尝试",
        readOnly: true,
      })
    if (next() !== undefined && !capped())
      list.push({
        category: "记录",
        title: "加载更早",
        value: "rows:more",
        description: "Enter 或 Ctrl+L",
        onSelect: () => void loadMore(),
      })
    return list
  })

  const panelOptions = createMemo<DialogSelectOption<string>[]>(() => {
    if (panel() === "model") {
      const selectedModel = model()
      return [
        { category: "选择模型", title: "← 返回", value: "panel:back", onSelect: closePanel },
        {
          category: "选择模型",
          title: "全部模型",
          value: "panel:model:all",
          description: selectedModel === undefined ? "当前已是全部" : "清除模型筛选",
          onSelect: () => {
            setModel(undefined)
            closePanel()
            reload()
          },
        },
        ...modelCatalog().map((entry) => ({
          category: "选择模型",
          title: `${entry.providerID}/${entry.modelID}`,
          value: `panel:model:${entry.providerID}/${entry.modelID}`,
          description: `账单 ${entry.steps.samples} · 请求 ${entry.requests.samples}`,
          onSelect: () => applyModel(entry),
        })),
      ]
    }
    const selectedWorkspace = workspaceFilter()
    return [
      { category: "选择工作区", title: "← 返回", value: "panel:back", onSelect: closePanel },
      {
        category: "选择工作区",
        title: "全部工作区",
        value: "panel:workspace:all",
        description: selectedWorkspace === undefined ? "当前已是全部" : "清除工作区筛选",
        onSelect: () => {
          setWorkspaceFilter(undefined)
          closePanel()
          reload()
        },
      },
      ...workspaceCatalog().flatMap((entry) => {
        const workspaceID = entry.workspaceID
        // 261126 Red 无工作区用字段缺失表达；不可选的空分组直接跳过。
        if (workspaceID === undefined) return []
        return [
          {
            category: "选择工作区",
            title: workspaceID,
            value: `panel:workspace:${workspaceID}`,
            description: `账单 ${entry.steps.samples} · 请求 ${entry.requests.samples}`,
            onSelect: () => applyWorkspace(workspaceID),
          },
        ]
      }),
    ]
  })

  const footerHints = createMemo(() => {
    const hints: { title: string; label: string }[] = [{ title: "记录", label: `${rows().length} 条` }]
    if (capped()) hints.push({ title: "已到上限", label: "更早记录未加载" })
    hints.push({ title: "查看", label: "Enter" })
    return hints
  })

  const actions = () => [
    {
      command: FLIGHT_RECORDER_GLOBAL_MORE,
      title: "加载更早",
      disabled: next() === undefined || capped() || rowsLoading() !== undefined,
      withoutSelection: true,
      onTrigger: () => void loadMore(),
    },
    {
      command: FLIGHT_RECORDER_GLOBAL_REFRESH,
      title: "刷新",
      withoutSelection: true,
      onTrigger: reload,
    },
  ]

  const bindings = () => [
    { key: "ctrl+l", cmd: FLIGHT_RECORDER_GLOBAL_MORE, desc: "加载更早", group: "Dialog" },
    { key: "ctrl+r", cmd: FLIGHT_RECORDER_GLOBAL_REFRESH, desc: "刷新", group: "Dialog" },
  ]

  function previousRow(row: GlobalRow): GlobalRow | undefined {
    const capture = row.diagnostics?.capture
    if (capture?.status !== "captured" || !capture.previousRequestID) return undefined
    return rows().find((item) => item.sessionID === row.sessionID && item.id === capture.previousRequestID)
  }

  return (
    <box flexDirection="column">
      <Show
        when={selected()}
        fallback={
        <Show
          when={panel()}
          fallback={
            <DialogSelect<string>
              title="执行历史 · 全局"
              placeholder="按模型、结果或日期过滤"
              options={mainOptions()}
              selectedKey={(option) => option.value}
              emptyContent="没有匹配记录"
              footerHints={footerHints()}
              actions={actions()}
              bindings={bindings()}
            />
          }
        >
          {(view) =>
            view() === "session" ? (
              <DialogPrompt
                title="按会话过滤"
                placeholder="输入会话 ID（ses_…）"
                value={sessionFilter()}
                onConfirm={applySession}
              />
            ) : (
              <DialogSelect<string>
                title={view() === "model" ? "执行历史 · 选择模型" : "执行历史 · 选择工作区"}
                placeholder="搜索"
                options={panelOptions()}
                selectedKey={(option) => option.value}
                emptyContent="没有可选分组"
              />
            )
          }
        </Show>
      }
    >
      {(row) => {
        const open = props.openSession
        return (
          <FlightRecorderDetail
            row={row()}
            previous={previousRow(row())}
            source={source()}
            session={{
              id: row().sessionID,
              workspaceID: row().workspaceID,
              sub: row().sub,
              open: open === undefined ? undefined : () => open(row().sessionID),
            }}
            onBack={() => setSelected(undefined)}
          />
        )
      }}
      </Show>
    </box>
  )
}

export function createFlightRecorderGlobalLoad(client: TuiPluginApi["client"]): FlightRecorderGlobalLoad {
  return {
    summary: async (query) => {
      const result = await client.session.flightRecorderSummary(query, { throwOnError: true })
      return { data: result.data }
    },
    rows: async (input) => {
      const result = await client.session.flightRecorderRows(input, { throwOnError: true })
      return { data: result.data }
    },
  }
}

const id = "internal:flight-recorder"

const tui: TuiPlugin = async (api) => {
  const load = createFlightRecorderGlobalLoad(api.client)
  api.keymap.registerLayer({
    priority: 1000,
    commands: [
      {
        name: FLIGHT_RECORDER_GLOBAL_COMMAND,
        title: "Open global execution history",
        desc: "Flight recorder · current server project/workspace · loaded on demand",
        category: "Context",
        namespace: "palette",
        run() {
          api.ui.dialog.replace(() => (
            <DialogFlightRecorderGlobal
              load={load}
              directory={api.state.path.directory}
              openSession={(sessionID) => {
                api.ui.dialog.clear()
                api.route.navigate("session", { sessionID })
              }}
            />
          ))
        },
      },
    ],
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
