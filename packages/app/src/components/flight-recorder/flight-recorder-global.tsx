import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@redcode-ai/ui/icon"
import { Select } from "@redcode-ai/ui/select"
import type {
  FlightRecorderCoverage as SdkFlightRecorderCoverage,
  FlightRecorderCostBucket as SdkFlightRecorderCostBucket,
  FlightRecorderGlobalPage as SdkFlightRecorderGlobalPage,
  FlightRecorderGlobalRow as SdkFlightRecorderGlobalRow,
  FlightRecorderGlobalSummary as SdkFlightRecorderGlobalSummary,
  FlightRecorderPercentiles as SdkFlightRecorderPercentiles,
  FlightRecorderRequestSummary as SdkFlightRecorderRequestSummary,
  FlightRecorderStepSummary as SdkFlightRecorderStepSummary,
  FlightRecorderUsage as SdkFlightRecorderUsage,
  Workspace as SdkWorkspace,
} from "@redcode-ai/sdk/v2/client"
import {
  createFlightRecorderFormat,
  DetailField,
  FlightRecorderDetail,
  flightRecorderCacheRatio,
  FLIGHT_RECORDER_MAX_ROWS,
  FLIGHT_RECORDER_PAGE_SIZE,
  type FlightRecorderFormat,
  type FlightRecorderSource,
  type FlightRecorderTranslate,
} from "@/components/session/session-flight-recorder"

// 261126 Red FR-04 全局执行历史：独立于当前会话，按当前服务器 + 当前项目（可再按工作区）
// 聚合两本账。数据只来自服务端有界聚合/分页，客户端不遍历会话，也不读其他服务器。
// 面板只在入口打开后挂载，因此未打开不会发任何查询；没有定时刷新。
// 查询走生成 SDK 的 typed 方法；本文件只保留筛选/加载器等 UI 形状。

export type FlightRecorderGlobalRange = "all" | "24h" | "7d" | "30d"
export const FLIGHT_RECORDER_GLOBAL_RANGES: readonly FlightRecorderGlobalRange[] = ["all", "24h", "7d", "30d"]

export const FLIGHT_RECORDER_GLOBAL_PAGE_SIZE = FLIGHT_RECORDER_PAGE_SIZE
export const FLIGHT_RECORDER_GLOBAL_MAX_ROWS = FLIGHT_RECORDER_MAX_ROWS
// Select 的“全部”用显式 sentinel：不能让 Kobalte 程序化同步的 undefined/空值冒充用户清除。
const FLIGHT_RECORDER_GLOBAL_ANY = "\u0000any"

export type FlightRecorderGlobalPercentiles = SdkFlightRecorderPercentiles
export type FlightRecorderGlobalUsage = SdkFlightRecorderUsage
export type FlightRecorderGlobalCacheStats = FlightRecorderGlobalUsage["cache"]
export type FlightRecorderGlobalCostBucket = SdkFlightRecorderCostBucket
export type FlightRecorderGlobalStepSummary = SdkFlightRecorderStepSummary
export type FlightRecorderGlobalRequestSummary = SdkFlightRecorderRequestSummary
export type FlightRecorderGlobalGroup = Pick<
  SdkFlightRecorderGlobalSummary["models"][number],
  "steps" | "requests"
>
export type FlightRecorderGlobalCoverage = SdkFlightRecorderCoverage
export type FlightRecorderGlobalSummary = SdkFlightRecorderGlobalSummary
export type FlightRecorderGlobalRow = SdkFlightRecorderGlobalRow
export type FlightRecorderGlobalPage = SdkFlightRecorderGlobalPage

export type FlightRecorderGlobalFilters = {
  from?: number
  to?: number
  providerID?: string
  modelID?: string
  sessionID?: string
  workspaceID?: string
}

export type FlightRecorderGlobalLoadSummary = (
  filters: FlightRecorderGlobalFilters,
) => FlightRecorderGlobalSummary | Promise<FlightRecorderGlobalSummary>

export type FlightRecorderGlobalRowsInput = FlightRecorderGlobalFilters & {
  source: FlightRecorderSource
  before?: string
  limit: number
}

export type FlightRecorderGlobalLoadRows = (
  input: FlightRecorderGlobalRowsInput,
) => FlightRecorderGlobalPage | Promise<FlightRecorderGlobalPage>

export type FlightRecorderGlobalWorkspace = Pick<SdkWorkspace, "id" | "name">

export type FlightRecorderGlobalLoadWorkspaces = () =>
  | FlightRecorderGlobalWorkspace[]
  | Promise<FlightRecorderGlobalWorkspace[]>

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 时间范围只做粗粒度收窄；to 是开区间，+1ms 让当前毫秒的记录也落在窗口内。 */
export function flightRecorderGlobalWindow(range: FlightRecorderGlobalRange, now: number): FlightRecorderGlobalFilters {
  if (range === "all") return {}
  const span = range === "24h" ? 86_400_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000
  return { from: now - span, to: now + 1 }
}

/**
 * 服务端已经给出 Σread/Σinput 的 hitRate；这里再做一次有限性与 read ≤ input 的守卫，
 * 缺报或异常值不出百分比，避免 UI 把不完整样本画成可信命中率。
 */
export function flightRecorderGlobalHitRate(cache: FlightRecorderGlobalCacheStats | undefined) {
  if (!cache) return
  if (!Number.isFinite(cache.input) || !Number.isFinite(cache.read)) return
  if (cache.input <= 0 || cache.read < 0 || cache.read > cache.input) return
  if (cache.hitRate !== undefined && Number.isFinite(cache.hitRate)) return cache.hitRate
  return cache.read / cache.input
}

export function flightRecorderGlobalRetention(summary: FlightRecorderGlobalSummary) {
  const value = summary.retention?.requestsPerSession
  if (value === undefined || !Number.isFinite(value) || value < 0) return
  return value
}

/** 模型筛选必须带上 provider：modelID 在跨 provider 时可能重名。 */
export function flightRecorderGlobalModelFilters(
  model: { providerID: string; modelID: string } | undefined,
): { providerID: string | undefined; modelID: string | undefined } {
  return model
    ? { providerID: model.providerID, modelID: model.modelID }
    : { providerID: undefined, modelID: undefined }
}

export function flightRecorderGlobalLowest(rows: FlightRecorderGlobalRow[]) {
  let lowest: { row: FlightRecorderGlobalRow; ratio: number } | undefined
  for (const row of rows) {
    const ratio = flightRecorderCacheRatio(row)
    if (ratio == null) continue
    if (!lowest || ratio < lowest.ratio) lowest = { row, ratio }
  }
  return lowest
}

export function flightRecorderGlobalShortID(id: string) {
  return id.length <= 10 ? id : `…${id.slice(-8)}`
}

function percentileLine(
  values: FlightRecorderGlobalPercentiles,
  format: FlightRecorderFormat,
  key: "stat.latency" | "stat.firstEvent",
  t: FlightRecorderTranslate,
) {
  const p50 = format.duration(values.p50)
  const p95 = format.duration(values.p95)
  const max = format.duration(values.max)
  return t(`flightRecorder.global.${key}`, { p50, p95, max })
}

function costLines(
  buckets: FlightRecorderGlobalCostBucket[],
  format: FlightRecorderFormat,
  t: FlightRecorderTranslate,
) {
  if (buckets.length === 0) return [t("flightRecorder.global.stat.noCost")]
  return buckets.map((bucket) => {
    const currency = bucket.currency ?? t("flightRecorder.global.currencyUnknown")
    const booked = format.cost(bucket.booked, bucket.currency, t("flightRecorder.global.currencyUnknown"))
    const estimated = format.cost(bucket.estimated, bucket.currency, t("flightRecorder.global.currencyUnknown"))
    if (bucket.missing === 0)
      return t("flightRecorder.global.stat.costBucket", { currency, booked, estimated })
    return t("flightRecorder.global.stat.costBucketMissing", {
      currency,
      booked,
      estimated,
      missing: bucket.missing.toString(),
    })
  })
}

function Tag(props: { children: JSX.Element; tone?: string }) {
  return (
    <span
      class="shrink-0 rounded bg-surface-weak px-1 text-11-regular"
      style={props.tone ? { color: props.tone } : undefined}
    >
      {props.children}
    </span>
  )
}

function SectionTitle(props: { children: JSX.Element; testid?: string }) {
  return (
    <div class="text-11-regular text-text-weak" data-testid={props.testid}>
      {props.children}
    </div>
  )
}

function StatRow(props: { label: string; value: JSX.Element; testid?: string }) {
  return (
    <div class="flex items-baseline justify-between gap-3 text-11-regular" data-testid={props.testid}>
      <span class="shrink-0 text-text-weaker">{props.label}</span>
      <span class="text-right text-text-base select-text">{props.value}</span>
    </div>
  )
}

function LedgerCard(props: {
  kind: "steps" | "requests"
  title: string
  summary: FlightRecorderGlobalStepSummary | FlightRecorderGlobalRequestSummary
  ownership: { main: FlightRecorderGlobalUsage; sub: FlightRecorderGlobalUsage }
  format: FlightRecorderFormat
  t: FlightRecorderTranslate
}) {
  const t = props.t
  const format = props.format
  const summary = props.summary
  const rate = () => flightRecorderGlobalHitRate(summary.usage.cache)
  const latency = () =>
    props.kind === "requests" ? (summary as FlightRecorderGlobalRequestSummary).latency : undefined
  const outcomes = () => {
    if (props.kind === "steps") {
      const value = (summary as FlightRecorderGlobalStepSummary).outcomes
      return `${t("flightRecorder.global.stat.booked", { count: value.booked.toString() })} · ${t(
        "flightRecorder.global.stat.estimated",
        { count: value.estimated.toString() },
      )}`
    }
    const value = (summary as FlightRecorderGlobalRequestSummary).outcomes
    return [
      t("flightRecorder.global.stat.failed", { count: value.failed.toString() }),
      t("flightRecorder.global.stat.cancelled", { count: value.cancelled.toString() }),
      t("flightRecorder.global.stat.unknown", { count: value.unknown.toString() }),
    ].join(" · ")
  }
  return (
    <div
      data-testid={`flight-recorder-global-${props.kind}`}
      class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-base bg-surface-base px-3 py-2"
    >
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-12-regular text-text-strong">{props.title}</span>
        <span class="text-11-regular text-text-weaker">
          {t("flightRecorder.global.stat.samples", { count: summary.samples.toString() })}
        </span>
      </div>
      <StatRow
        label={t("flightRecorder.global.stat.sessions")}
        value={t("flightRecorder.global.stat.sessionsValue", {
          main: summary.sessions.main.toString(),
          sub: summary.sessions.sub.toString(),
        })}
      />
      <StatRow
        label={t("flightRecorder.global.stat.hitRate")}
        value={
          <span data-testid={`flight-recorder-global-${props.kind}-hit-rate`}>
            {format.percent((rate() ?? undefined) === undefined ? undefined : rate()! * 100)}
          </span>
        }
      />
      <div class="text-11-regular text-text-weaker">
        {t("flightRecorder.global.stat.hitRateDetail", {
          read: format.number(summary.usage.cache.read),
          input: format.number(summary.usage.cache.input),
        })}
      </div>
      <div class="text-11-regular text-text-weaker">
        {t("flightRecorder.global.stat.hitSamples", {
          samples: summary.usage.cache.samples.toString(),
          invalid: summary.usage.cache.excluded.invalid.toString(),
          incomplete: summary.usage.cache.excluded.incomplete.toString(),
        })}
      </div>
      <StatRow
        label={t("flightRecorder.global.stat.ownership")}
        value={t("flightRecorder.global.stat.ownershipValue", {
          main: props.ownership.main.samples.toString(),
          sub: props.ownership.sub.samples.toString(),
          output: format.number(props.ownership.main.output + props.ownership.sub.output),
        })}
      />
      <StatRow label={t("flightRecorder.global.field.outcome")} value={outcomes()} />
      <Show when={latency()}>
        {(value) => (
          <div class="flex flex-col gap-0.5 text-11-regular text-text-weaker">
            <span>
              {value().samples === 0
                ? t("flightRecorder.global.stat.noLatency")
                : percentileLine(value().durationMs, format, "stat.latency", t)}
            </span>
            <Show when={value().samples > 0}>
              <span>{percentileLine(value().firstEventMs, format, "stat.firstEvent", t)}</span>
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.kind === "steps"}>
        <div class="flex flex-col gap-0.5 text-11-regular text-text-weaker">
          <span class="text-text-weak">{t("flightRecorder.global.stat.cost")}</span>
          <For each={costLines((summary as FlightRecorderGlobalStepSummary).cost, format, t)}>
            {(line) => <span data-testid="flight-recorder-global-steps-cost">{line}</span>}
          </For>
        </div>
      </Show>
    </div>
  )
}

function GroupLine(props: {
  name: string
  group: FlightRecorderGlobalGroup
  type: "model" | "workspace"
  format: FlightRecorderFormat
  t: FlightRecorderTranslate
}) {
  const t = props.t
  const format = props.format
  const stepsRate = () => flightRecorderGlobalHitRate(props.group.steps.usage.cache)
  const requestsRate = () => flightRecorderGlobalHitRate(props.group.requests.usage.cache)
  const cost = () => costLines(props.group.steps.cost, format, t).join(" + ")
  const failed = () => props.group.requests.outcomes.failed
  return (
    <div
      data-testid={`flight-recorder-global-${props.type}`}
      class="flex min-w-0 flex-col gap-0.5 border-b border-border-base py-1 last:border-b-0"
    >
      <div class="truncate text-11-regular text-text-base select-text">{props.name}</div>
      <div class="flex flex-wrap gap-x-2 text-11-regular text-text-weaker">
        <span>
          {t("flightRecorder.global.groups.stepsLine", {
            count: props.group.steps.samples.toString(),
            rate: format.percent(stepsRate() === undefined ? undefined : stepsRate()! * 100),
            valid: props.group.steps.usage.cache.samples.toString(),
            cost: cost(),
          })}
        </span>
        <span>
          {t("flightRecorder.global.groups.requestsLine", {
            count: props.group.requests.samples.toString(),
            rate: format.percent(requestsRate() === undefined ? undefined : requestsRate()! * 100),
            valid: props.group.requests.usage.cache.samples.toString(),
            failed: failed().toString(),
            p95: format.duration(props.group.requests.latency.durationMs.p95),
          })}
        </span>
      </div>
    </div>
  )
}

function Trend(props: {
  daily: FlightRecorderGlobalSummary["daily"]
  format: FlightRecorderFormat
  t: FlightRecorderTranslate
}) {
  const t = props.t
  const format = props.format
  const max = createMemo(() => ({
    steps: Math.max(1, ...props.daily.map((day) => day.steps.samples)),
    requests: Math.max(1, ...props.daily.map((day) => day.requests.samples)),
  }))
  return (
    <div data-testid="flight-recorder-global-trend" class="flex flex-col gap-1">
      <div class="flex items-center gap-3 text-11-regular text-text-weaker">
        <span>{t("flightRecorder.global.trend.steps")}</span>
        <span class="inline-block h-1.5 w-6 rounded-full" style={{ "background-color": "var(--syntax-info)" }} />
        <span>{t("flightRecorder.global.trend.requests")}</span>
        <span class="inline-block h-1.5 w-6 rounded-full" style={{ "background-color": "var(--syntax-success)" }} />
      </div>
      <Show
        when={props.daily.length > 0}
        fallback={<div class="text-11-regular text-text-weaker">{t("flightRecorder.global.trend.none")}</div>}
      >
        <For each={props.daily}>
          {(day) => (
            <div class="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-11-regular">
              <span class="text-text-weaker tabular-nums">{day.day}</span>
              <span class="flex items-center gap-1">
                <span class="block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-weak" aria-hidden="true">
                  <span
                    class="block h-full"
                    style={{
                      width: `${(day.steps.samples / max().steps) * 100}%`,
                      "background-color": "var(--syntax-info)",
                    }}
                  />
                </span>
                <span class="w-12 shrink-0 text-right text-text-weak tabular-nums">
                  {format.number(day.steps.samples)}
                </span>
              </span>
              <span class="flex items-center gap-1">
                <span class="block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-weak" aria-hidden="true">
                  <span
                    class="block h-full"
                    style={{
                      width: `${(day.requests.samples / max().requests) * 100}%`,
                      "background-color": "var(--syntax-success)",
                    }}
                  />
                </span>
                <span class="w-12 shrink-0 text-right text-text-weak tabular-nums">
                  {format.number(day.requests.samples)}
                </span>
                <span class="w-16 shrink-0 text-right text-text-weaker tabular-nums">
                  {t("flightRecorder.global.trend.failed", { count: day.requests.outcomes.failed.toString() })}
                </span>
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function CoverageLine(props: {
  label: string
  coverage: FlightRecorderGlobalCoverage | undefined
  format: FlightRecorderFormat
  t: FlightRecorderTranslate
}) {
  const t = props.t
  return (
    <div class="flex items-baseline justify-between gap-2 text-11-regular">
      <span class="shrink-0 text-text-weaker">{props.label}</span>
      <span class="text-right text-text-base">
        {t("flightRecorder.global.window.ledger", {
          scanned: props.coverage?.scanned.toString() ?? "0",
          from: props.format.time(props.coverage?.from),
          to: props.format.time(props.coverage?.to),
        })}
      </span>
    </div>
  )
}

function GlobalRowDetail(props: {
  row: FlightRecorderGlobalRow
  previous?: FlightRecorderGlobalRow
  source: FlightRecorderSource
  format: FlightRecorderFormat
  t: FlightRecorderTranslate
  onOpenSession?: (sessionID: string) => Promise<void>
  onFilterSession: (sessionID: string) => void
  onOpenRequest?: (requestID: string) => void
}) {
  const t = props.t
  const [jumpError, setJumpError] = createSignal<string>()
  const [jumping, setJumping] = createSignal(false)
  const jump = async () => {
    if (!props.onOpenSession) return
    setJumping(true)
    setJumpError(undefined)
    try {
      await props.onOpenSession(props.row.sessionID)
    } catch (error) {
      setJumpError(t("flightRecorder.global.detail.jumpFailed", { error: errorMessage(error) }))
    } finally {
      setJumping(false)
    }
  }
  return (
    <div
      data-testid="flight-recorder-global-detail"
      data-detail-id={props.row.id}
      class="flex flex-col gap-1 border-t border-border-base px-2 py-2"
    >
      <div class="text-11-regular text-text-weak">{t("context.flightRecorder.detail")}</div>
      <DetailField label={t("flightRecorder.global.detail.session")} value={props.row.sessionID} />
      <DetailField
        label={t("flightRecorder.global.detail.workspace")}
        value={props.row.workspaceID || t("flightRecorder.global.groups.localWorkspace")}
      />
      <DetailField
        label={t("flightRecorder.global.detail.kind")}
        value={t(props.row.sub ? "flightRecorder.global.detail.kind.sub" : "flightRecorder.global.detail.kind.main")}
      />
      <div class="flex flex-wrap gap-1.5">
        <Show when={props.onOpenSession}>
          <button
            type="button"
            data-testid="flight-recorder-global-open-session"
            class="rounded-md bg-surface-weak px-2 py-1 text-11-regular text-text-strong disabled:opacity-60"
            disabled={jumping()}
            onClick={() => void jump()}
          >
            {t("flightRecorder.global.detail.openSession")}
          </button>
        </Show>
        <button
          type="button"
          data-testid="flight-recorder-global-filter-session"
          class="rounded-md bg-surface-weak px-2 py-1 text-11-regular text-text-strong"
          onClick={() => props.onFilterSession(props.row.sessionID)}
        >
          {t("flightRecorder.global.detail.filterSession")}
        </button>
      </div>
      <Show when={jumpError()}>
        {(error) => (
          <div role="alert" class="text-11-regular break-all" style={{ color: "var(--syntax-critical)" }}>
            {error()}
          </div>
        )}
      </Show>
      <div class="text-11-regular text-text-weaker">{t("flightRecorder.global.detail.note")}</div>
      <FlightRecorderDetail
        row={props.row}
        previous={props.previous}
        source={props.source}
        t={t}
        format={props.format}
        onOpenRequest={props.onOpenRequest}
      />
    </div>
  )
}

function GlobalRowItem(props: {
  row: FlightRecorderGlobalRow
  previous?: FlightRecorderGlobalRow
  source: FlightRecorderSource
  format: FlightRecorderFormat
  t: FlightRecorderTranslate
  workspaceName: string | undefined
  open: boolean
  onToggle: () => void
  onOpenSession?: (sessionID: string) => Promise<void>
  onFilterSession: (sessionID: string) => void
  onOpenRequest?: (requestID: string) => void
}) {
  const t = props.t
  const format = props.format
  const ratio = () => flightRecorderCacheRatio(props.row)
  const outcome = () =>
    props.row.outcome === "unknown" ? "—" : t(`context.flightRecorder.outcome.${props.row.outcome}`)
  return (
    <div
      data-testid="flight-recorder-global-row"
      data-row-id={props.row.id}
      class="rounded-md border border-border-base bg-surface-base"
      style={props.open ? { "border-color": "var(--text-weak)" } : undefined}
    >
      <button
        type="button"
        class="flex w-full flex-col gap-1 px-2 py-1.5 text-left"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <div class="flex items-baseline justify-between gap-2 text-11-regular">
          <span class="truncate text-text-weak">{format.time(props.row.time)}</span>
          <span class="flex shrink-0 items-center gap-1.5">
            <Tag>{t("flightRecorder.global.rows.session", { id: flightRecorderGlobalShortID(props.row.sessionID) })}</Tag>
            <Show when={props.row.sub}>
              <Tag>{t("flightRecorder.global.rows.sub")}</Tag>
            </Show>
            <span style={{ color: "var(--text-weaker)" }}>{outcome()}</span>
          </span>
        </div>
        <div class="flex items-baseline justify-between gap-2 text-11-regular">
          <span class="truncate text-text-base select-text">{props.row.modelID || "—"}</span>
          <span class="shrink-0 text-text-weak">
            {t("context.flightRecorder.inOut", {
              input: format.number(props.row.input),
              output: format.number(props.row.output),
            })}
          </span>
        </div>
        <div class="flex items-center justify-between gap-2 text-11-regular text-text-weaker">
          <span class="truncate">
            {props.row.providerID || "—"}
            <Show when={props.row.workspaceID}>
              <span> · {props.workspaceName ?? flightRecorderGlobalShortID(props.row.workspaceID!)}</span>
            </Show>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <Show when={props.row.cost != null}>
              <span>{format.cost(props.row.cost, props.row.currency, t("context.flightRecorder.currencyUnknown"))}</span>
            </Show>
            <Show when={props.row.durationMs != null}>
              <span>{format.duration(props.row.durationMs)}</span>
            </Show>
            <Show when={ratio() != null}>
              <span class="flex items-center gap-1">
                <span>{format.percent(ratio()! * 100)}</span>
                <span class="block h-1 w-10 overflow-hidden rounded-full bg-surface-weak" aria-hidden="true">
                  <span
                    class="block h-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, ratio()! * 100))}%`,
                      "background-color": "var(--syntax-info)",
                    }}
                  />
                </span>
              </span>
            </Show>
          </span>
        </div>
      </button>
      <Show when={props.open}>
        <GlobalRowDetail
          row={props.row}
          previous={props.previous}
          source={props.source}
          format={format}
          t={t}
          onOpenSession={props.onOpenSession}
          onFilterSession={props.onFilterSession}
          onOpenRequest={props.onOpenRequest}
        />
      </Show>
    </div>
  )
}

type PanelFilters = {
  range: FlightRecorderGlobalRange
  providerID?: string
  modelID?: string
  workspaceID?: string
  sessionID?: string
}

type LoadState<T> = {
  loading: boolean
  loaded: boolean
  error?: string
  data?: T
}

type RowsState = {
  loading: boolean
  loadingMore: boolean
  loaded: boolean
  error?: string
  items: FlightRecorderGlobalRow[]
  next?: string
  scanned: number
  truncated: boolean
  capped: boolean
  /** 最近一页在 provider/model 过滤后为空，但仍有更旧窗口可继续扫描。 */
  emptyPage: boolean
}

export type FlightRecorderGlobalPanelProps = {
  serverName: string
  projectName: string
  loadSummary: FlightRecorderGlobalLoadSummary
  loadRows: FlightRecorderGlobalLoadRows
  loadWorkspaces?: FlightRecorderGlobalLoadWorkspaces
  t: FlightRecorderTranslate
  locale: () => string
  now?: () => number
  pageSize?: number
  maxRows?: number
  onOpenSession?: (sessionID: string) => Promise<void>
}

export function FlightRecorderGlobalPanel(props: FlightRecorderGlobalPanelProps) {
  const t = props.t
  const pageSize = () => props.pageSize ?? FLIGHT_RECORDER_GLOBAL_PAGE_SIZE
  const maxRows = () => props.maxRows ?? FLIGHT_RECORDER_GLOBAL_MAX_ROWS
  const now = () => props.now?.() ?? Date.now()
  const format = createMemo(() => createFlightRecorderFormat(props.locale()))

  const [filters, setFilters] = createStore<PanelFilters>({ range: "all" })
  const [state, setState] = createStore<{
    source: FlightRecorderSource
    summary: LoadState<FlightRecorderGlobalSummary>
    rows: RowsState
  }>({
    source: "steps",
    summary: { loading: false, loaded: false },
    rows: {
      loading: false,
      loadingMore: false,
      loaded: false,
      items: [],
      scanned: 0,
      truncated: false,
      capped: false,
      emptyPage: false,
    },
  })
  const [options, setOptions] = createStore<{
    baseline?: FlightRecorderGlobalSummary
    workspaces: FlightRecorderGlobalWorkspace[]
    workspacesError?: string
  }>({ workspaces: [] })
  const [sessionInput, setSessionInput] = createSignal("")
  const [providerInput, setProviderInput] = createSignal("")
  const [modelInput, setModelInput] = createSignal("")
  const [workspaceInput, setWorkspaceInput] = createSignal("")

  let summaryToken = 0
  let rowsToken = 0
  let disposed = false
  let lastFilters: FlightRecorderGlobalFilters = {}
  let root: HTMLDivElement | undefined
  const [selected, setSelected] = createSignal<string>()
  const [requestLink, setRequestLink] = createSignal<{
    id: string
    status: "missing" | "error"
    message?: string
  }>()

  onCleanup(() => {
    disposed = true
    summaryToken++
    rowsToken++
  })

  const effectiveFilters = (): FlightRecorderGlobalFilters => {
    const window = flightRecorderGlobalWindow(filters.range, now())
    return {
      ...window,
      ...(filters.providerID ? { providerID: filters.providerID } : {}),
      ...(filters.modelID ? { modelID: filters.modelID } : {}),
      ...(filters.workspaceID ? { workspaceID: filters.workspaceID } : {}),
      ...(filters.sessionID ? { sessionID: filters.sessionID } : {}),
    }
  }

  const isBaseline = (value: FlightRecorderGlobalFilters) => Object.keys(value).length === 0

  const loadSummary = async (value: FlightRecorderGlobalFilters, token: number) => {
    setState("summary", { loading: true, loaded: false, error: undefined, data: undefined })
    try {
      const data = await props.loadSummary(value)
      if (disposed || token !== summaryToken) return
      setState("summary", { loading: false, loaded: true, data })
      if (!options.baseline && isBaseline(value)) setOptions("baseline", data)
    } catch (error) {
      if (disposed || token !== summaryToken) return
      setState("summary", { loading: false, loaded: true, error: errorMessage(error) })
    }
  }

  const loadRows = async (
    value: FlightRecorderGlobalFilters,
    mode: "reset" | "more",
    token: number,
  ): Promise<"ok" | "stopped" | "error"> => {
    if (mode === "more" && (!state.rows.next || state.rows.loadingMore || state.rows.capped)) return "stopped"
    if (mode === "reset")
      setState("rows", {
        loading: true,
        loadingMore: false,
        loaded: false,
        error: undefined,
        items: [],
        next: undefined,
        scanned: 0,
        truncated: false,
        capped: false,
        emptyPage: false,
      })
    else setState("rows", "loadingMore", true)
    try {
      const page = await props.loadRows({
        ...value,
        source: state.source,
        before: mode === "more" ? state.rows.next : undefined,
        limit: pageSize(),
      })
      if (disposed || token !== rowsToken) return "stopped"
      const seen = new Set(state.rows.items.map((row) => row.id))
      const fresh = page.items.filter((row) => !seen.has(row.id))
      const combined = mode === "reset" ? page.items : [...state.rows.items, ...fresh]
      const capped = combined.length > maxRows() || (combined.length >= maxRows() && !!page.next)
      setState("rows", {
        items: combined.slice(0, maxRows()),
        next: capped ? undefined : page.next,
        loading: false,
        loadingMore: false,
        loaded: true,
        error: undefined,
        scanned: page.scanned,
        truncated: page.truncated,
        capped,
        emptyPage: page.items.length === 0,
      })
      return "ok"
    } catch (error) {
      if (disposed || token !== rowsToken) return "stopped"
      setState("rows", { loading: false, loadingMore: false, loaded: true, error: errorMessage(error) })
      return "error"
    }
  }

  const reload = () => {
    lastFilters = effectiveFilters()
    setSelected(undefined)
    setRequestLink(undefined)
    void loadSummary(lastFilters, ++summaryToken)
    void loadRows(lastFilters, "reset", ++rowsToken)
  }

  // 工作区列表失败不能静默：选择器会少项，用户至少要知道并能手输/重试。
  const loadWorkspaceOptions = () => {
    if (!props.loadWorkspaces) return
    const load = props.loadWorkspaces
    void Promise.resolve(load())
      .then((list) => {
        if (!disposed) setOptions({ workspaces: list, workspacesError: undefined })
      })
      .catch((error) => {
        if (!disposed) setOptions("workspacesError", errorMessage(error))
      })
  }

  onMount(() => {
    reload()
    loadWorkspaceOptions()
  })

  const setRange = (range: FlightRecorderGlobalRange) => {
    if (filters.range === range) return
    setFilters("range", range)
    reload()
  }

  const applyProvider = (value: string) => {
    // 只有显式选择 sentinel 或手动清空才走 value === ""；Kobalte 程序化同步的 undefined
    // 在 onSelect 里就丢弃，不会抹掉手动 provider。
    if ((filters.providerID ?? "") === value) return
    const providerID = value || undefined
    const modelID =
      filters.modelID &&
      models().some((model) => model.modelID === filters.modelID && (!providerID || model.providerID === providerID))
        ? filters.modelID
        : undefined
    setFilters({ providerID, modelID })
    setProviderInput(value)
    if (!modelID) setModelInput("")
    reload()
  }

  const applyModel = (model?: { providerID: string; modelID: string }) => {
    // 模型选择器没有“全部”项；undefined 只可能是 Kobalte 同步，不能因此清掉已有筛选。
    if (!model) return
    const next = flightRecorderGlobalModelFilters(model)
    if (filters.providerID === next.providerID && filters.modelID === next.modelID) return
    setFilters({ providerID: next.providerID, modelID: next.modelID })
    setModelInput(next.modelID ?? "")
    if (next.providerID) setProviderInput(next.providerID)
    reload()
  }

  const applyWorkspace = (value: string) => {
    if ((filters.workspaceID ?? "") === value) return
    setFilters("workspaceID", value || undefined)
    setWorkspaceInput(value)
    reload()
  }

  const applyProviderInput = () => {
    const value = providerInput().trim()
    if (value) return applyProvider(value)
    if (!filters.providerID && !filters.modelID) return
    setFilters({ providerID: undefined, modelID: undefined })
    setModelInput("")
    reload()
  }

  const applyModelInput = () => {
    const value = modelInput().trim()
    if ((filters.modelID ?? "") === value) return
    setFilters("modelID", value || undefined)
    reload()
  }

  const applyWorkspaceInput = () => {
    const value = workspaceInput().trim()
    if ((filters.workspaceID ?? "") === value) return
    setFilters("workspaceID", value || undefined)
    reload()
  }

  const applySession = () => {
    const value = sessionInput().trim()
    setFilters("sessionID", value || undefined)
    reload()
  }

  const clearFilters = () => {
    setFilters({ range: "all", providerID: undefined, modelID: undefined, workspaceID: undefined, sessionID: undefined })
    setSessionInput("")
    setProviderInput("")
    setModelInput("")
    setWorkspaceInput("")
    reload()
  }

  const setSource = (source: FlightRecorderSource) => {
    if (state.source === source) return
    setState("source", source)
    setSelected(undefined)
    setRequestLink(undefined)
    setState("rows", {
      loading: true,
      loadingMore: false,
      loaded: false,
      error: undefined,
      items: [],
      next: undefined,
      scanned: 0,
      truncated: false,
      capped: false,
      emptyPage: false,
    })
    void loadRows(lastFilters, "reset", ++rowsToken)
  }

  type RevealRequest =
    | { status: "found"; row: FlightRecorderGlobalRow }
    | { status: "missing" }
    | { status: "error"; message: string }

  // 步骤账的可选 requestID 只在能按需加载到的请求行里找详情；找不到不推断“已淘汰”。
  // 分页失败必须立即停下并等人工重试，不能带着 next 自动重扫。
  const revealRequest = async (requestID: string, retry = false): Promise<RevealRequest> => {
    if (retry || state.source !== "requests" || (state.rows.error && state.rows.items.length === 0)) {
      setState("source", "requests")
      setSelected(undefined)
      setState("rows", {
        loading: true,
        loadingMore: false,
        loaded: false,
        error: undefined,
        items: [],
        next: undefined,
        scanned: 0,
        truncated: false,
        capped: false,
        emptyPage: false,
      })
      await loadRows(lastFilters, "reset", ++rowsToken)
      if (state.rows.error) return { status: "error", message: state.rows.error }
    }
    let found = state.rows.items.find((row) => row.id === requestID)
    while (!found && state.rows.next && !state.rows.capped && state.rows.items.length < maxRows()) {
      const result = await loadRows(lastFilters, "more", rowsToken)
      if (result === "error") return { status: "error", message: state.rows.error ?? requestID }
      if (result === "stopped") break
      found = state.rows.items.find((row) => row.id === requestID)
    }
    return found ? { status: "found", row: found } : { status: "missing" }
  }

  const openLinkedRequest = async (requestID: string, retry = false) => {
    const result = await revealRequest(requestID, retry)
    if (result.status === "found") {
      setRequestLink(undefined)
      setSelected(result.row.id)
      revealDetail(result.row.id)
      return
    }
    setRequestLink({
      id: requestID,
      status: result.status,
      ...(result.status === "error" ? { message: result.message } : {}),
    })
  }

  const refresh = () => {
    reload()
  }

  // 两个错误各自只重试自己的一本请求；全量重取留给刷新按钮，避免“重试摘要”顺手
  // 把另一本账的成功状态也重置掉。
  const retrySummary = () => {
    lastFilters = effectiveFilters()
    void loadSummary(lastFilters, ++summaryToken)
  }

  const retryRows = () => {
    lastFilters = effectiveFilters()
    void loadRows(lastFilters, "reset", ++rowsToken)
  }

  const providerOptions = createMemo(() => {
    const providers = new Set<string>()
    for (const model of options.baseline?.models ?? []) providers.add(model.providerID)
    // 摘要失败/截断时手动输入的 provider 不在 baseline 里；仍要放进选项，否则 Kobalte
    // 同步选中值时会把它当成未知值回调成空，悄悄清掉刚输入的手动筛选。
    if (filters.providerID) providers.add(filters.providerID)
    return [FLIGHT_RECORDER_GLOBAL_ANY, ...providers]
  })

  const models = createMemo(() => {
    const list = options.baseline?.models ?? []
    if (!filters.providerID) return list
    return list.filter((model) => model.providerID === filters.providerID)
  })

  const modelKey = (model: { providerID: string; modelID: string }) => `${model.providerID}\u0000${model.modelID}`
  const currentModel = createMemo(() => {
    if (!filters.modelID) return undefined
    return models().find(
      (model) =>
        model.modelID === filters.modelID &&
        (!filters.providerID || model.providerID === filters.providerID),
    )
  })

  const workspaceNames = createMemo(() => {
    const names = new Map<string, string>()
    for (const workspace of options.workspaces) names.set(workspace.id, workspace.name)
    return names
  })

  const workspaceOptions = createMemo(() => {
    const ids = new Set<string>()
    for (const group of options.baseline?.workspaces ?? []) if (group.workspaceID) ids.add(group.workspaceID)
    for (const workspace of options.workspaces) ids.add(workspace.id)
    if (filters.workspaceID) ids.add(filters.workspaceID)
    return [FLIGHT_RECORDER_GLOBAL_ANY, ...[...ids].sort()]
  })

  const workspaceLabel = (id: string) =>
    workspaceNames().get(id) ?? t("flightRecorder.global.groups.workspace", { id: flightRecorderGlobalShortID(id) })

  const workspaceName = (id: string | undefined) => (id ? workspaceLabel(id) : undefined)

  const lowest = createMemo(() => flightRecorderGlobalLowest(state.rows.items))

  const revealDetail = (id: string) => {
    requestAnimationFrame(() => {
      const detail = Array.from(
        root?.querySelectorAll<HTMLElement>('[data-testid="flight-recorder-global-detail"]') ?? [],
      ).find((element) => element.getAttribute("data-detail-id") === id)
      detail?.scrollIntoView({ block: "nearest" })
    })
  }

  const toggleRow = (id: string) => {
    const next = selected() === id ? undefined : id
    setSelected(next)
    if (next) revealDetail(next)
  }

  const filterSession = (sessionID: string) => {
    setSessionInput(sessionID)
    setFilters("sessionID", sessionID)
    setSelected(undefined)
    reload()
  }

  const summary = () => state.summary.data

  return (
    <div ref={(element) => (root = element)} data-testid="flight-recorder-global-panel" class="flex flex-col gap-3">
      <div
        data-testid="flight-recorder-global-scope"
        class="flex flex-col gap-0.5 rounded-md border border-border-base bg-surface-base px-3 py-2 text-11-regular"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span class="text-text-base">
            {t("flightRecorder.global.scope.line", {
              server: props.serverName,
              project: props.projectName,
              workspace: filters.workspaceID
                ? t("flightRecorder.global.scope.workspace", { workspace: workspaceLabel(filters.workspaceID) })
                : t("flightRecorder.global.scope.workspaceScope"),
            })}
          </span>
          <Show when={filters.sessionID}>
            {(id) => (
              <span class="text-text-weak">
                {t("flightRecorder.global.scope.session", { session: flightRecorderGlobalShortID(id()) })}
              </span>
            )}
          </Show>
          <button
            type="button"
            data-testid="flight-recorder-global-refresh"
            class="ml-auto rounded-md px-1.5 py-0.5 text-text-weak"
            aria-label={t("flightRecorder.global.refresh")}
            title={t("flightRecorder.global.refresh")}
            disabled={state.summary.loading || state.rows.loading || state.rows.loadingMore}
            onClick={refresh}
          >
            <Icon name="reset" size="small" />
          </button>
        </div>
        <div class="text-text-weaker">{t("flightRecorder.global.scope.note")}</div>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-11-regular">
        <div class="flex shrink-0 gap-0.5 rounded-md bg-surface-base p-0.5" role="group" aria-label={t("flightRecorder.global.filter.time")}>
          <For each={FLIGHT_RECORDER_GLOBAL_RANGES}>
            {(range) => (
              <button
                type="button"
                data-testid={`flight-recorder-global-range-${range}`}
                aria-pressed={filters.range === range}
                classList={{
                  "rounded px-2 py-0.5": true,
                  "bg-surface-weak text-text-strong": filters.range === range,
                  "text-text-weaker": filters.range !== range,
                }}
                onClick={() => setRange(range)}
              >
                {t(`flightRecorder.global.filter.range.${range}`)}
              </button>
            )}
          </For>
        </div>
        <Select
          options={providerOptions()}
          current={filters.providerID ?? FLIGHT_RECORDER_GLOBAL_ANY}
          value={(value) => value}
          label={(value) =>
            value === FLIGHT_RECORDER_GLOBAL_ANY ? t("flightRecorder.global.filter.all") : value
          }
          placeholder={t("flightRecorder.global.filter.provider")}
          aria-label={t("flightRecorder.global.filter.provider")}
          onSelect={(value) => {
            if (value === undefined) return
            applyProvider(value === FLIGHT_RECORDER_GLOBAL_ANY ? "" : value)
          }}
        />
        <Select
          options={models()}
          current={currentModel()}
          value={modelKey}
          label={(model) => `${model.providerID} / ${model.modelID}`}
          placeholder={t("flightRecorder.global.filter.model")}
          aria-label={t("flightRecorder.global.filter.model")}
          onSelect={(value) => applyModel(value)}
        />
        <Select
          options={workspaceOptions()}
          current={filters.workspaceID ?? FLIGHT_RECORDER_GLOBAL_ANY}
          value={(value) => value}
          label={(value) =>
            value === FLIGHT_RECORDER_GLOBAL_ANY
              ? t("flightRecorder.global.filter.all")
              : workspaceLabel(value)
          }
          placeholder={t("flightRecorder.global.filter.workspace")}
          aria-label={t("flightRecorder.global.filter.workspace")}
          onSelect={(value) => {
            if (value === undefined) return
            applyWorkspace(value === FLIGHT_RECORDER_GLOBAL_ANY ? "" : value)
          }}
        />
        <form
          class="flex min-w-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            applyProviderInput()
          }}
        >
          <input
            type="text"
            data-testid="flight-recorder-global-provider-input"
            class="min-w-0 rounded-md border border-border-base bg-surface-base px-2 py-1 text-11-regular text-text-base outline-none"
            value={providerInput()}
            placeholder={t("flightRecorder.global.filter.provider.placeholder")}
            aria-label={t("flightRecorder.global.filter.provider.placeholder")}
            spellcheck={false}
            onInput={(event) => setProviderInput(event.currentTarget.value)}
          />
          <button
            type="submit"
            data-testid="flight-recorder-global-provider-apply"
            class="rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
          >
            {t("flightRecorder.global.filter.apply")}
          </button>
        </form>
        <form
          class="flex min-w-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            applyModelInput()
          }}
        >
          <input
            type="text"
            data-testid="flight-recorder-global-model-input"
            class="min-w-0 rounded-md border border-border-base bg-surface-base px-2 py-1 text-11-regular text-text-base outline-none"
            value={modelInput()}
            placeholder={t("flightRecorder.global.filter.model.placeholder")}
            aria-label={t("flightRecorder.global.filter.model.placeholder")}
            spellcheck={false}
            onInput={(event) => setModelInput(event.currentTarget.value)}
          />
          <button
            type="submit"
            data-testid="flight-recorder-global-model-apply"
            class="rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
          >
            {t("flightRecorder.global.filter.apply")}
          </button>
        </form>
        <form
          class="flex min-w-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            applyWorkspaceInput()
          }}
        >
          <input
            type="text"
            data-testid="flight-recorder-global-workspace-input"
            class="min-w-0 rounded-md border border-border-base bg-surface-base px-2 py-1 text-11-regular text-text-base outline-none"
            value={workspaceInput()}
            placeholder={t("flightRecorder.global.filter.workspace.placeholder")}
            aria-label={t("flightRecorder.global.filter.workspace.placeholder")}
            spellcheck={false}
            onInput={(event) => setWorkspaceInput(event.currentTarget.value)}
          />
          <button
            type="submit"
            data-testid="flight-recorder-global-workspace-apply"
            class="rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
          >
            {t("flightRecorder.global.filter.apply")}
          </button>
        </form>
        <form
          class="flex min-w-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            applySession()
          }}
        >
          <input
            type="text"
            data-testid="flight-recorder-global-session-input"
            class="min-w-0 rounded-md border border-border-base bg-surface-base px-2 py-1 text-11-regular text-text-base outline-none"
            value={sessionInput()}
            placeholder={t("flightRecorder.global.filter.session.placeholder")}
            aria-label={t("flightRecorder.global.filter.session")}
            spellcheck={false}
            onInput={(event) => setSessionInput(event.currentTarget.value)}
          />
          <button
            type="submit"
            data-testid="flight-recorder-global-session-apply"
            class="rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
          >
            {t("flightRecorder.global.filter.apply")}
          </button>
        </form>
        <button
          type="button"
          data-testid="flight-recorder-global-clear"
          class="rounded-md px-2 py-1 text-11-regular text-text-weaker"
          onClick={clearFilters}
        >
          {t("flightRecorder.global.filter.clear")}
        </button>
      </div>

      <Show when={options.workspacesError}>
        {(error) => (
          <div
            data-testid="flight-recorder-global-workspaces-error"
            class="flex flex-col gap-1 rounded-md border border-border-base px-2 py-1.5"
          >
            <div class="text-11-regular" style={{ color: "var(--syntax-warning)" }}>
              {t("flightRecorder.global.workspaces.error", { error: error() })}
            </div>
            <button
              type="button"
              data-testid="flight-recorder-global-workspaces-retry"
              class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
              onClick={loadWorkspaceOptions}
            >
              {t("flightRecorder.global.workspaces.retry")}
            </button>
          </div>
        )}
      </Show>

      <Show
        when={!state.summary.loading}
        fallback={<div class="text-11-regular text-text-weaker">{t("flightRecorder.global.loading")}</div>}
      >
        <Show when={state.summary.error}>
          {(error) => (
            <div data-testid="flight-recorder-global-summary-error" class="flex flex-col gap-1 rounded-md border border-border-base px-2 py-1.5">
              <div class="text-11-regular" style={{ color: "var(--syntax-critical)" }}>
                {t("flightRecorder.global.error")}
              </div>
              <div class="break-all text-11-regular text-text-weaker select-text">{error()}</div>
              <button
                type="button"
                data-testid="flight-recorder-global-summary-retry"
                class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
                onClick={retrySummary}
              >
                {t("flightRecorder.global.retry")}
              </button>
            </div>
          )}
        </Show>
        <Show when={summary()}>
          {(data) => (
            <>
              <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <LedgerCard
                  kind="steps"
                  title={t("flightRecorder.global.ledger.steps")}
                  summary={data().steps}
                  ownership={data().ownership.steps}
                  format={format()}
                  t={t}
                />
                <LedgerCard
                  kind="requests"
                  title={t("flightRecorder.global.ledger.requests")}
                  summary={data().requests}
                  ownership={data().ownership.requests}
                  format={format()}
                  t={t}
                />
              </div>
              <div class="text-11-regular text-text-weaker">{t("flightRecorder.global.ledger.note")}</div>
              <div class="text-11-regular text-text-weaker">{t("flightRecorder.global.note.hitRate")}</div>
              <div class="text-11-regular text-text-weaker">{t("flightRecorder.global.note.stepsCost")}</div>
              <div class="text-11-regular text-text-weaker">{t("flightRecorder.global.note.requests")}</div>

              <div data-testid="flight-recorder-global-window" class="flex flex-col gap-1 rounded-md border border-border-base px-3 py-2">
                <SectionTitle>{t("flightRecorder.global.window.title")}</SectionTitle>
                <CoverageLine
                  label={t("flightRecorder.global.ledger.steps")}
                  coverage={data().coverage.steps}
                  format={format()}
                  t={t}
                />
                <CoverageLine
                  label={t("flightRecorder.global.ledger.requests")}
                  coverage={data().coverage.requests}
                  format={format()}
                  t={t}
                />
                <Show when={data().truncated || data().next}>
                  <div class="text-11-regular" style={{ color: "var(--syntax-warning)" }}>
                    {t("flightRecorder.global.window.truncated")}
                  </div>
                </Show>
                <Show when={data().breakdownsTruncated}>
                  <div class="text-11-regular" style={{ color: "var(--syntax-warning)" }}>
                    {t("flightRecorder.global.window.breakdowns", {
                      groups: data().limits.groups.toString(),
                      days: data().limits.trendDays.toString(),
                    })}
                  </div>
                </Show>
                <div class="text-11-regular text-text-weaker">
                  {t("flightRecorder.global.window.scan", {
                    scan: format().number(data().limits.scan),
                    pageScan:
                      data().limits.pageScan === undefined ? "—" : format().number(data().limits.pageScan),
                  })}
                </div>
                <Show
                  when={flightRecorderGlobalRetention(data()) !== undefined}
                  fallback={
                    <div class="text-11-regular text-text-weaker">
                      {t("flightRecorder.global.window.retentionUnknown")}
                    </div>
                  }
                >
                  <div class="text-11-regular text-text-weaker">
                    {t("flightRecorder.global.window.retention", {
                      retention: format().number(flightRecorderGlobalRetention(data())),
                    })}
                  </div>
                </Show>
              </div>

              <div class="flex flex-col gap-1 rounded-md border border-border-base px-3 py-2">
                <SectionTitle testid="flight-recorder-global-models-title">{t("flightRecorder.global.groups.models")}</SectionTitle>
                <Show
                  when={data().models.length > 0}
                  fallback={<div class="text-11-regular text-text-weaker">{t("flightRecorder.global.groups.none")}</div>}
                >
                  <For each={data().models}>
                    {(group) => (
                      <GroupLine
                        name={`${group.providerID || "—"} / ${group.modelID || "—"}`}
                        group={group}
                        type="model"
                        format={format()}
                        t={t}
                      />
                    )}
                  </For>
                </Show>
              </div>

              <div class="flex flex-col gap-1 rounded-md border border-border-base px-3 py-2">
                <SectionTitle testid="flight-recorder-global-workspaces-title">{t("flightRecorder.global.groups.workspaces")}</SectionTitle>
                <Show
                  when={data().workspaces.length > 0}
                  fallback={<div class="text-11-regular text-text-weaker">{t("flightRecorder.global.groups.none")}</div>}
                >
                  <For each={data().workspaces}>
                    {(group) => (
                      <GroupLine
                        name={
                          group.workspaceID
                            ? workspaceLabel(group.workspaceID)
                            : t("flightRecorder.global.groups.localWorkspace")
                        }
                        group={group}
                        type="workspace"
                        format={format()}
                        t={t}
                      />
                    )}
                  </For>
                </Show>
              </div>

              <div class="flex flex-col gap-1 rounded-md border border-border-base px-3 py-2">
                <SectionTitle testid="flight-recorder-global-trend-title">{t("flightRecorder.global.trend.title")}</SectionTitle>
                <Trend daily={data().daily} format={format()} t={t} />
              </div>
            </>
          )}
        </Show>
      </Show>

      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label={t("flightRecorder.global.rows.sources")} class="flex items-center gap-1">
            <For each={["steps", "requests"] as const}>
              {(source) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.source === source}
                  data-testid={`flight-recorder-global-source-${source}`}
                  classList={{
                    "rounded-md px-2 py-1 text-11-regular": true,
                    "bg-surface-base text-text-strong": state.source === source,
                    "text-text-weaker": state.source !== source,
                  }}
                  onClick={() => setSource(source)}
                >
                  {t(`context.flightRecorder.source.${source}`)}
                </button>
              )}
            </For>
          </div>
          <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-global-rows-scanned">
            {t("flightRecorder.global.rows.scanned", { count: state.rows.scanned.toString() })}
          </div>
        </div>
        <div class="text-11-regular text-text-weaker">
          {state.source === "steps" ? t("flightRecorder.global.rows.stepsNote") : t("flightRecorder.global.rows.requestsNote")}
        </div>
        <Show when={state.rows.truncated}>
          <div class="text-11-regular" style={{ color: "var(--syntax-warning)" }} data-testid="flight-recorder-global-rows-truncated">
            {t("flightRecorder.global.rows.truncated")}
          </div>
        </Show>
        <Show when={!state.rows.loading && state.rows.loaded && state.rows.emptyPage && state.rows.next}>
          <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-global-rows-empty-page">
            {t("flightRecorder.global.rows.emptyWithNext")}
          </div>
        </Show>

        <Show when={state.rows.error}>
          {(error) => (
            <div data-testid="flight-recorder-global-rows-error" class="flex flex-col gap-1 rounded-md border border-border-base px-2 py-1.5">
              <div class="text-11-regular" style={{ color: "var(--syntax-critical)" }}>
                {t("flightRecorder.global.error")}
              </div>
              <div class="break-all text-11-regular text-text-weaker select-text">{error()}</div>
              <button
                type="button"
                data-testid="flight-recorder-global-rows-retry"
                class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
                onClick={retryRows}
              >
                {t("flightRecorder.global.retry")}
              </button>
            </div>
          )}
        </Show>

        <Show when={state.rows.loading}>
          <div class="text-11-regular text-text-weaker">{t("flightRecorder.global.loading")}</div>
        </Show>

        <Show
          when={
            !state.rows.loading &&
            state.rows.loaded &&
            !state.rows.error &&
            state.rows.items.length === 0
          }
        >
          <div data-testid="flight-recorder-global-rows-empty" class="text-11-regular text-text-weaker">
            {state.rows.next
              ? t("flightRecorder.global.rows.emptyWithNext")
              : t("flightRecorder.global.rows.empty")}
          </div>
        </Show>

        <Show when={requestLink()}>
          {(link) => (
            <Show
              when={link().status === "error"}
              fallback={
                <div data-testid="flight-recorder-global-request-missing" class="text-11-regular text-text-weaker">
                  {t("context.flightRecorder.field.request.missing", { request: link().id })}
                </div>
              }
            >
              <div
                data-testid="flight-recorder-global-request-error"
                class="flex flex-col gap-1 rounded-md border border-border-base px-2 py-1.5"
              >
                <div class="text-11-regular" style={{ color: "var(--syntax-critical)" }}>
                  {t("flightRecorder.global.request.error", { error: link().message ?? "" })}
                </div>
                <button
                  type="button"
                  data-testid="flight-recorder-global-request-retry"
                  class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
                  onClick={() => void openLinkedRequest(link().id, true)}
                >
                  {t("flightRecorder.global.request.retry")}
                </button>
              </div>
            </Show>
          )}
        </Show>

        <Show when={state.rows.items.length > 0}>
          <Show when={lowest()}>
            {(low) => (
              <button
                type="button"
                data-testid="flight-recorder-global-lowest"
                class="truncate text-left text-11-regular text-text-weak"
                onClick={() => {
                  setSelected(low().row.id)
                  revealDetail(low().row.id)
                }}
              >
                {t("flightRecorder.global.rows.lowest", {
                  percent: format().percent(low().ratio * 100),
                  time: format().time(low().row.time),
                })}
              </button>
            )}
          </Show>
          <div class="flex flex-col gap-1">
            <For each={state.rows.items}>
              {(row) => {
                const previous = () => {
                  const capture = row.diagnostics?.capture
                  return capture?.status === "captured" && capture.previousRequestID
                    ? state.rows.items.find((item) => item.id === capture.previousRequestID)
                    : undefined
                }
                return (
                  <GlobalRowItem
                    row={row}
                    previous={previous()}
                    source={state.source}
                    format={format()}
                    t={t}
                    workspaceName={workspaceName(row.workspaceID)}
                    open={selected() === row.id}
                    onToggle={() => toggleRow(row.id)}
                    onOpenSession={props.onOpenSession}
                    onFilterSession={filterSession}
                    onOpenRequest={(requestID) => void openLinkedRequest(requestID)}
                  />
                )
              }}
            </For>
          </div>
          <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-global-rows-scope">
            {t("flightRecorder.global.rows.scope", {
              count: state.rows.items.length.toString(),
              oldest: format().time(state.rows.items[state.rows.items.length - 1]?.time),
            })}
          </div>
        </Show>

        <Show when={state.rows.capped}>
          <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-global-rows-cap">
            {t("flightRecorder.global.rows.cap", { count: maxRows().toString() })}
          </div>
        </Show>
        <Show
          when={
            state.rows.loaded &&
            !state.rows.loading &&
            !state.rows.error &&
            !state.rows.capped &&
            !!state.rows.next
          }
        >
          <button
            type="button"
            data-testid="flight-recorder-global-load-more"
            class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong disabled:opacity-60"
            disabled={state.rows.loadingMore}
            onClick={() => void loadRows(lastFilters, "more", rowsToken)}
          >
            {state.rows.loadingMore
              ? t("flightRecorder.global.rows.loadingMore")
              : t("flightRecorder.global.rows.loadMore")}
          </button>
        </Show>
        <Show
          when={
            state.rows.loaded &&
            !state.rows.loading &&
            !state.rows.error &&
            !state.rows.capped &&
            !state.rows.next &&
            state.rows.items.length > 0
          }
        >
          <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-global-rows-end">
            {state.source === "steps"
              ? t("flightRecorder.global.rows.end.steps")
              : t("flightRecorder.global.rows.end.requests")}
          </div>
        </Show>
      </div>
    </div>
  )
}
