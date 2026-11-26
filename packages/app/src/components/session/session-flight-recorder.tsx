import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { CapsuleRow } from "@redcode-ai/ui/capsule"
import { Icon } from "@redcode-ai/ui/icon"
import { Meter } from "@redcode-ai/ui/meter"
import type { FlightRecorderDiagnostics, FlightRecorderPage, FlightRecorderRow } from "@redcode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/context/session-layout"

// 261126 Red Flight Recorder V1：Context 面板里按需展开的执行历史。
// 默认折叠，面板不挂载就不发请求；切会话由 sessionID effect 清空并重取，避免串账。
// 账单步骤（steps）与启用后记录的实际请求（requests）是两个来源，不混算。

export type FlightRecorderSource = "steps" | "requests"

export type FlightRecorderLoadInput = {
  sessionID: string
  source: FlightRecorderSource
  before?: string
  limit: number
}

export type FlightRecorderLoad = (input: FlightRecorderLoadInput) => Promise<FlightRecorderPage>

export type FlightRecorderTranslate = (key: string, params?: Record<string, string | number | boolean>) => string

export const FLIGHT_RECORDER_PAGE_SIZE = 20
export const FLIGHT_RECORDER_MAX_ROWS = 128

type FlightRecorderState = {
  source: FlightRecorderSource
  rows: FlightRecorderRow[]
  next?: string
  loading: boolean
  loadingMore: boolean
  loaded: boolean
  capped: boolean
  error?: string
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * 命中率的单行资格。命中率只在能解释的样本上计算：
 * - estimated / unknown 不是实报，不计；
 * - 缺分母、input <= 0、cacheRead < 0、cacheRead > input 的异常值不计。
 * 账面（steps）与请求（requests）的零值都保留：steps 的 0 是历史归一化结果，
 * 剔除它会把历史加权命中率系统性抬高；口径差异由标题与说明承担，不改样本。
 */
export function flightRecorderCacheRatio(row: FlightRecorderRow) {
  if (row.outcome === "estimated" || row.outcome === "unknown") return
  const input = row.input
  const cacheRead = row.cacheRead
  if (input == null || cacheRead == null) return
  if (!Number.isFinite(input) || !Number.isFinite(cacheRead)) return
  if (input <= 0 || cacheRead < 0 || cacheRead > input) return
  return cacheRead / input
}

export function flightRecorderRatio(rows: FlightRecorderRow[]) {
  let covered = 0
  let cacheRead = 0
  let input = 0
  for (const row of rows) {
    if (flightRecorderCacheRatio(row) == null) continue
    covered++
    cacheRead += row.cacheRead!
    input += row.input!
  }
  if (covered === 0 || input <= 0) return
  return { value: cacheRead / input, covered, total: rows.length }
}

export function flightRecorderLowest(rows: FlightRecorderRow[]) {
  let lowest: { row: FlightRecorderRow; ratio: number } | undefined
  for (const row of rows) {
    const ratio = flightRecorderCacheRatio(row)
    if (ratio == null) continue
    if (!lowest || ratio < lowest.ratio) lowest = { row, ratio }
  }
  return lowest
}

// 费用只聚合实际带 cost 的行，并按原币种分组；不换算、不混算。
export function flightRecorderCosts(rows: FlightRecorderRow[]) {
  const groups = new Map<string, number>()
  let covered = 0
  for (const row of rows) {
    if (row.cost == null || !Number.isFinite(row.cost)) continue
    covered++
    const currency = row.currency?.trim() ?? ""
    groups.set(currency, (groups.get(currency) ?? 0) + row.cost)
  }
  return {
    items: [...groups].map(([currency, amount]) => ({ currency, amount })),
    covered,
    total: rows.length,
  }
}

export function createFlightRecorderFormat(locale: string) {
  const number = new Intl.NumberFormat(locale)
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const time = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const currencies = new Map<string, Intl.NumberFormat | null>()
  const currency = (code: string) => {
    if (!currencies.has(code)) {
      try {
        currencies.set(code, code ? new Intl.NumberFormat(locale, { style: "currency", currency: code }) : null)
      } catch {
        // 非法/缺失的 ISO 币种交给 number() 原样显示，不猜汇率也不吞掉金额
        currencies.set(code, null)
      }
    }
    return currencies.get(code) ?? undefined
  }
  return {
    number(value: number | null | undefined) {
      if (value == null || !Number.isFinite(value)) return "—"
      return number.format(value)
    },
    percent(value: number | null | undefined) {
      if (value == null || !Number.isFinite(value)) return "—"
      return `${percent.format(value)}%`
    },
    time(value: number | null | undefined) {
      if (value == null || !Number.isFinite(value)) return "—"
      return time.format(new Date(value))
    },
    duration(value: number | null | undefined) {
      if (value == null || !Number.isFinite(value)) return "—"
      if (Math.abs(value) < 1000) return `${number.format(value)} ms`
      return `${seconds.format(value / 1000)} s`
    },
    cost(value: number | null | undefined, code: string | null | undefined, unknown = "?") {
      if (value == null || !Number.isFinite(value)) return "—"
      const formatter = code ? currency(code) : undefined
      if (formatter) return formatter.format(value)
      return [number.format(value), code || unknown].filter(Boolean).join(" ")
    },
  }
}

export type FlightRecorderFormat = ReturnType<typeof createFlightRecorderFormat>

function createFlightRecorderState(props: {
  sessionID: () => string | undefined
  loadPage: FlightRecorderLoad
  pageSize?: number
  maxRows?: number
}) {
  const pageSize = () => props.pageSize ?? FLIGHT_RECORDER_PAGE_SIZE
  const maxRows = () => props.maxRows ?? FLIGHT_RECORDER_MAX_ROWS
  const [state, setState] = createStore<FlightRecorderState>({
    source: "steps",
    rows: [],
    loading: false,
    loadingMore: false,
    loaded: false,
    capped: false,
  })

  // 每次重取递增；旧请求晚到时对不上 token 就丢弃。切会话/切来源/刷新都走这里。
  let epoch = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    epoch++
  })

  const reset = () => {
    setState({
      rows: [],
      next: undefined,
      loading: false,
      loadingMore: false,
      loaded: true,
      capped: false,
      error: undefined,
    })
  }

  const load = async (source: FlightRecorderSource) => {
    const sessionID = props.sessionID()
    const token = ++epoch
    setState({
      source,
      rows: [],
      next: undefined,
      loading: true,
      loadingMore: false,
      loaded: false,
      capped: false,
      error: undefined,
    })
    if (!sessionID) {
      setState({ loading: false, loaded: true })
      return
    }
    try {
      const page = await props.loadPage({ sessionID, source, limit: pageSize() })
      if (disposed || token !== epoch) return
      const rows = page.items.slice(0, maxRows())
      const truncated = page.items.length > maxRows() || (rows.length >= maxRows() && !!page.next)
      setState({
        rows,
        next: truncated ? undefined : page.next,
        loading: false,
        loaded: true,
        capped: truncated,
      })
    } catch (error) {
      if (disposed || token !== epoch) return
      setState({ loading: false, loaded: true, error: errorMessage(error) })
    }
  }

  const loadMore = async () => {
    const sessionID = props.sessionID()
    const before = state.next
    if (!sessionID || !before || state.loading || state.loadingMore || state.capped) return
    const token = epoch
    const source = state.source
    setState("loadingMore", true)
    try {
      const page = await props.loadPage({ sessionID, source, before, limit: pageSize() })
      if (disposed || token !== epoch) return
      const seen = new Set(state.rows.map((row) => row.id))
      const fresh = page.items.filter((row) => !seen.has(row.id))
      const combined = [...state.rows, ...fresh]
      const rows = combined.slice(0, maxRows())
      const truncated = combined.length > maxRows() || (combined.length >= maxRows() && !!page.next)
      setState({
        rows,
        // 没有新增就停住 cursor，避免同一页反复请求；达到上限也不再翻。
        next: truncated || fresh.length === 0 ? undefined : page.next,
        loadingMore: false,
        capped: truncated,
        error: undefined,
      })
    } catch (error) {
      if (disposed || token !== epoch) return
      setState({ loadingMore: false, error: errorMessage(error) })
    }
  }

  const refresh = () => void load(untrack(() => state.source))
  const setSource = (source: FlightRecorderSource) => {
    if (state.source === source) return
    void load(source)
  }
  const retry = () => {
    if (state.rows.length > 0 && state.next) void loadMore()
    else refresh()
  }

  createEffect(
    on(
      () => props.sessionID(),
      (sessionID) => {
        epoch++
        if (!sessionID) {
          reset()
          return
        }
        void load(untrack(() => state.source))
      },
      { defer: false },
    ),
  )

  return { state, setSource, loadMore, refresh, retry }
}

const OUTCOME_COLOR: Partial<Record<FlightRecorderRow["outcome"], string>> = {
  booked: "var(--syntax-info)",
  estimated: "var(--text-weak)",
  completed: "var(--syntax-success)",
  failed: "var(--syntax-critical)",
  cancelled: "var(--syntax-warning)",
}

const PREFIX_COLOR: Record<string, string> = {
  baseline: "var(--syntax-comment)",
  unchanged: "var(--syntax-success)",
  append: "var(--syntax-info)",
  rewind: "var(--syntax-warning)",
  rewrite: "var(--syntax-critical)",
}

function DetailField(props: { label: string; value: JSX.Element; color?: string }) {
  return (
    <div class="flex items-baseline justify-between gap-3 text-11-regular">
      <span class="text-text-weaker shrink-0">{props.label}</span>
      <span class="text-text-base text-right break-all select-text" style={props.color ? { color: props.color } : undefined}>
        {props.value}
      </span>
    </div>
  )
}

function PrefixChip(props: { label: string; state: string; t: FlightRecorderTranslate }) {
  return (
    <span class="rounded px-1 py-0.5" style={{ color: PREFIX_COLOR[props.state] ?? "var(--text-weaker)" }}>
      {props.label}: {props.t(`context.flightRecorder.prefix.${props.state}`)}
    </span>
  )
}

function FlightRecorderDetail(props: {
  row: FlightRecorderRow
  previous?: FlightRecorderRow
  source: FlightRecorderSource
  t: FlightRecorderTranslate
  format: FlightRecorderFormat
}) {
  const t = props.t
  const format = props.format
  const row = props.row
  const outcome = () => (row.outcome === "unknown" ? "—" : t(`context.flightRecorder.outcome.${row.outcome}`))
  return (
    <div
      data-testid="flight-recorder-detail"
      data-detail-id={props.row.id}
      class="border-t border-border-base px-2 py-2 flex flex-col gap-1"
    >
      <div class="text-11-regular text-text-weak">{t("context.flightRecorder.detail")}</div>
      <DetailField label={t("context.flightRecorder.field.id")} value={row.id} />
      <DetailField label={t("context.flightRecorder.field.message")} value={row.messageID} />
      <DetailField label={t("context.flightRecorder.field.time")} value={format.time(row.time)} />
      <DetailField label={t("context.flightRecorder.field.provider")} value={row.providerID || "—"} />
      <DetailField label={t("context.flightRecorder.field.model")} value={row.modelID || "—"} />
      <DetailField
        label={t("context.flightRecorder.field.outcome")}
        value={outcome()}
        color={OUTCOME_COLOR[row.outcome] ?? "var(--text-weaker)"}
      />
      <DetailField
        label={t("context.flightRecorder.field.summary")}
        value={row.summary ? t("context.flightRecorder.summaryTag") : "—"}
      />
      <DetailField label={t("context.flightRecorder.field.input")} value={format.number(row.input)} />
      <DetailField label={t("context.flightRecorder.field.output")} value={format.number(row.output)} />
      <DetailField label={t("context.flightRecorder.field.cacheRead")} value={format.number(row.cacheRead)} />
      <DetailField label={t("context.flightRecorder.field.cacheWrite")} value={format.number(row.cacheWrite)} />
      <DetailField
        label={t(
          props.source === "steps"
            ? "context.flightRecorder.field.cacheMiss.steps"
            : "context.flightRecorder.field.cacheMiss",
        )}
        value={format.number(row.cacheMiss)}
      />
      <Show when={props.source === "steps"}>
        <div class="text-11-regular text-text-weaker">{t("context.flightRecorder.ledgerCacheNote")}</div>
      </Show>
      <DetailField label={t("context.flightRecorder.field.cost")} value={format.cost(row.cost, row.currency, t("context.flightRecorder.currencyUnknown"))} />
      <DetailField label={t("context.flightRecorder.field.duration")} value={format.duration(row.durationMs)} />
      <DetailField label={t("context.flightRecorder.field.firstEvent")} value={format.duration(row.firstEventMs)} />
      <div class="text-11-regular text-text-weaker">{t("context.flightRecorder.firstEventNote")}</div>
      <Show when={row.diagnostics}>
        {(data) => <RequestDiagnostics data={data()} previous={props.previous} t={t} format={format} />}
      </Show>
      <Show
        when={!row.diagnostics?.capture && row.prefix}
        fallback={
          <Show when={!row.diagnostics?.capture}>
            <div class="text-11-regular text-text-weaker">
              {props.source === "steps"
                ? t("context.flightRecorder.prefix.missing.steps")
                : t("context.flightRecorder.prefix.missing.requests")}
            </div>
          </Show>
        }
      >
        {(prefix) => (
          <>
            <div data-testid="flight-recorder-prefix" class="flex flex-col gap-1 text-11-regular">
              <div class="text-text-weaker">{t("context.flightRecorder.field.prefix")}</div>
              <div class="flex flex-wrap gap-x-2 gap-y-1">
                <PrefixChip label={t("context.flightRecorder.prefix.system")} state={prefix().system} t={t} />
                <PrefixChip label={t("context.flightRecorder.prefix.tools")} state={prefix().tools} t={t} />
                <PrefixChip label={t("context.flightRecorder.prefix.history")} state={prefix().history} t={t} />
              </div>
            </div>
            <DetailField
              label={t("context.flightRecorder.field.compressed")}
              value={
                prefix().compressed
                  ? t("context.flightRecorder.prefix.compressed")
                  : t("context.flightRecorder.prefix.noNewCompaction")
              }
            />
            <div class="text-11-regular text-text-weaker">{t("context.flightRecorder.prefix.compactionNote")}</div>
            <div class="text-11-regular text-text-weaker">{t("context.flightRecorder.prefix.note")}</div>
          </>
        )}
      </Show>
    </div>
  )
}

function RequestDiagnostics(props: {
  data: FlightRecorderDiagnostics
  previous?: FlightRecorderRow
  t: FlightRecorderTranslate
  format: FlightRecorderFormat
}) {
  const t = props.t
  const format = props.format
  const label = (key: string, params?: Record<string, string>) => t(`context.flightRecorder.diagnostics.${key}`, params)
  const transition = (change: string) => t(`context.flightRecorder.prefix.${change}`)
  const amount = (value: number, delta?: number) =>
    delta === undefined
      ? format.number(value)
      : `${format.number(value)} (${delta > 0 ? "+" : ""}${format.number(delta)})`
  const fields = createMemo(() => {
    const data = props.data
    const fields = [{ label: label("runtime"), value: data.runtime === "native" ? "Native" : "AI SDK" }]
    const capture = data.capture
    if (capture?.status === "unsupported") {
      fields.push({ label: label("captureFailure"), value: label(`reason.${capture.reason}`) })
    }
    if (capture?.status === "captured") {
      fields.push({ label: label("previous"), value: capture.previousRequestID ?? transition("baseline") })
      if (capture.previousRequestID) {
        const rate = props.previous && flightRecorderCacheRatio(props.previous)
        fields.push({ label: label("previousRate"), value: rate === undefined ? "—" : format.percent(rate * 100) })
      }
      for (const name of ["system", "tools", "history"] as const) {
        const section = capture[name]
        const value = label("section", {
          change: transition(section.change),
          count: amount(section.count, section.countDelta),
          bytes: amount(section.bytes, section.bytesDelta),
        })
        fields.push({
          label: t(`context.flightRecorder.prefix.${name}`),
          value:
            section.firstDifference === undefined
              ? value
              : `${value} · ${label("firstDifference", {
                  index: format.number(section.firstDifference + 1),
                })}`,
        })
      }
      for (const name of ["parameters", "wire", "serialized", "affinity"] as const) {
        fields.push({ label: label(name), value: transition(capture[name]) })
      }
      fields.push({
        label: t("context.flightRecorder.field.compressed"),
        value: t(
          capture.compacted || capture.compression
            ? "context.flightRecorder.prefix.compressed"
            : "context.flightRecorder.prefix.noNewCompaction",
        ),
      })
      const compression = capture.compression
      if (compression)
        fields.push({
          label: label("compression"),
          value: label("compressionStats", {
            receipts: format.number(compression.receipts),
            blocks: format.number(compression.blockCount),
            input: format.number(compression.inputTokensEstimated),
            summary: format.number(compression.summaryTokensEstimated),
            saved: format.number(compression.netSavingsEstimated),
          }),
        })
    }
    const instructions = data.instructions
    if (instructions) {
      for (const name of ["inputTokens", "cachedTokens", "cacheWriteTokens", "missTokens"] as const) {
        fields.push({ label: label(name), value: format.number(instructions[name]) })
      }
    }
    if (data.unattributedInputTokens !== undefined) {
      fields.push({ label: label("unattributed"), value: format.number(data.unattributedInputTokens) })
    }
    return fields
  })
  return (
    <div data-testid="flight-recorder-diagnostics" class="flex flex-col gap-1">
      <For each={fields()}>{(field) => <DetailField {...field} />}</For>
      <Show when={props.data.capture?.status === "captured"}>
        <div class="text-11-regular text-text-weaker">{t("context.flightRecorder.prefix.note")}</div>
      </Show>
    </div>
  )
}

function FlightRecorderRowItem(props: {
  row: FlightRecorderRow
  previous?: FlightRecorderRow
  source: FlightRecorderSource
  t: FlightRecorderTranslate
  format: FlightRecorderFormat
  open: boolean
  onToggle: () => void
}) {
  const ratio = () => flightRecorderCacheRatio(props.row)
  const outcome = () =>
    props.row.outcome === "unknown"
      ? "—"
      : props.t(`context.flightRecorder.outcome.${props.row.outcome}`)
  return (
    <div
      data-testid="flight-recorder-row"
      data-row-id={props.row.id}
      class="border border-border-base rounded-md bg-surface-base"
      style={props.open ? { "border-color": "var(--text-weak)" } : undefined}
    >
      <button
        type="button"
        class="w-full text-left px-2 py-1.5 flex flex-col gap-1"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <div class="flex items-baseline justify-between gap-2 text-11-regular">
          <span class="text-text-weak truncate">{props.format.time(props.row.time)}</span>
          <span class="flex items-center gap-1.5 shrink-0">
            <Show when={props.row.summary}>
              <span class="rounded bg-surface-weak px-1 text-text-weak">{props.t("context.flightRecorder.summaryTag")}</span>
            </Show>
            <span style={{ color: OUTCOME_COLOR[props.row.outcome] ?? "var(--text-weaker)" }}>{outcome()}</span>
          </span>
        </div>
        <div class="flex items-baseline justify-between gap-2 text-11-regular">
          <span class="text-text-base truncate select-text">{props.row.modelID || "—"}</span>
          <span class="text-text-weak shrink-0">
            {props.t("context.flightRecorder.inOut", {
              input: props.format.number(props.row.input),
              output: props.format.number(props.row.output),
            })}
          </span>
        </div>
        <div class="flex items-center justify-between gap-2 text-11-regular text-text-weaker">
          <span class="truncate">{props.row.providerID || "—"}</span>
          <span class="flex items-center gap-2 shrink-0">
            <Show when={props.row.cost != null}>
              <span>{props.format.cost(props.row.cost, props.row.currency, props.t("context.flightRecorder.currencyUnknown"))}</span>
            </Show>
            <Show when={props.row.durationMs != null}>
              <span>{props.format.duration(props.row.durationMs)}</span>
            </Show>
            <Show when={ratio() != null}>
              <span class="flex items-center gap-1">
                <span>{props.format.percent(ratio()! * 100)}</span>
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
        <FlightRecorderDetail
          row={props.row}
          previous={props.previous}
          source={props.source}
          t={props.t}
          format={props.format}
        />
      </Show>
    </div>
  )
}

export function FlightRecorderPanel(props: {
  sessionID: () => string | undefined
  loadPage: FlightRecorderLoad
  t: FlightRecorderTranslate
  locale: () => string
  pageSize?: number
  maxRows?: number
}) {
  const state = createFlightRecorderState(props)
  const format = createMemo(() => createFlightRecorderFormat(props.locale()))
  const ratio = createMemo(() => flightRecorderRatio(state.state.rows))
  const lowest = createMemo(() => flightRecorderLowest(state.state.rows))
  const costs = createMemo(() => flightRecorderCosts(state.state.rows))
  const [selected, setSelected] = createSignal<string>()
  let root: HTMLDivElement | undefined

  const ratioLabel = () =>
    state.state.source === "steps"
      ? props.t("context.flightRecorder.ledgerCacheRatio")
      : props.t("context.flightRecorder.cacheRatio")
  const ratioNote = () =>
    state.state.source === "steps"
      ? props.t("context.flightRecorder.ledgerRatioNote")
      : props.t("context.flightRecorder.ratioNote")

  // 低点/行详情展开后要把详情滚进视口；只在列表下方静默长高会让人以为按钮没反应。
  const revealDetail = (id: string) => {
    requestAnimationFrame(() => {
      const detail = Array.from(
        root?.querySelectorAll<HTMLElement>('[data-testid="flight-recorder-detail"]') ?? [],
      ).find((element) => element.getAttribute("data-detail-id") === id)
      detail?.scrollIntoView({ block: "nearest" })
    })
  }
  const toggleRow = (id: string) => {
    const next = selected() === id ? undefined : id
    setSelected(next)
    if (next) revealDetail(next)
  }

  createEffect(
    on(
      () => [state.state.source, props.sessionID() ?? ""].join(":"),
      () => setSelected(undefined),
      { defer: true },
    ),
  )

  return (
    <div ref={(element) => (root = element)} data-testid="flight-recorder-panel" class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <div role="tablist" aria-label={props.t("context.flightRecorder.sources")} class="flex items-center gap-1">
          <For each={["steps", "requests"] as const}>
            {(source) => (
              <button
                type="button"
                role="tab"
                aria-selected={state.state.source === source}
                data-testid={`flight-recorder-source-${source}`}
                classList={{
                  "rounded-md px-2 py-1 text-11-regular": true,
                  "bg-surface-base text-text-strong": state.state.source === source,
                  "text-text-weaker": state.state.source !== source,
                }}
                onClick={() => state.setSource(source)}
              >
                {source === "steps"
                  ? props.t("context.flightRecorder.source.steps")
                  : props.t("context.flightRecorder.source.requests")}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          data-testid="flight-recorder-refresh"
          class="rounded-md px-1.5 py-1 text-text-weak"
          aria-label={props.t("context.flightRecorder.refresh")}
          title={props.t("context.flightRecorder.refresh")}
          disabled={state.state.loading || state.state.loadingMore}
          onClick={state.refresh}
        >
          <Icon name="reset" size="small" />
        </button>
      </div>

      <div class="text-11-regular text-text-weaker">
        {state.state.source === "steps"
          ? props.t("context.flightRecorder.stepsNote")
          : props.t("context.flightRecorder.requestsNote")}
      </div>

      <Show when={state.state.error}>
        {(error) => (
          <div data-testid="flight-recorder-error" class="flex flex-col gap-1 rounded-md border border-border-base px-2 py-1.5">
            <div class="text-11-regular" style={{ color: "var(--syntax-critical)" }}>
              {props.t("context.flightRecorder.error")}
            </div>
            <div class="text-11-regular text-text-weaker break-all select-text">{error()}</div>
            <button
              type="button"
              data-testid="flight-recorder-retry"
              class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
              onClick={state.retry}
            >
              {props.t("context.flightRecorder.retry")}
            </button>
          </div>
        )}
      </Show>

      <Show when={state.state.loading}>
        <div class="text-11-regular text-text-weaker">{props.t("context.flightRecorder.loading")}</div>
      </Show>

      <Show when={!state.state.loading && state.state.loaded && !state.state.error && state.state.rows.length === 0}>
        <div data-testid="flight-recorder-empty" class="text-11-regular text-text-weaker">
          {state.state.source === "steps"
            ? props.t("context.flightRecorder.empty.steps")
            : props.t("context.flightRecorder.empty.requests")}
        </div>
      </Show>

      <Show when={state.state.rows.length > 0}>
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2 text-11-regular">
            <span class="text-text-weak" data-testid="flight-recorder-ratio-label">{ratioLabel()}</span>
            <span class="text-text-base" data-testid="flight-recorder-ratio">
              {ratio() ? format().percent(ratio()!.value * 100) : "—"}
            </span>
          </div>
          <Show
            when={ratio()}
            fallback={<div class="text-11-regular text-text-weaker">{props.t("context.flightRecorder.noRatio")}</div>}
          >
            {(value) => (
              <>
                <Meter
                  size="thin"
                  value={value().value * 100}
                  color="var(--syntax-info)"
                  label={ratioLabel()}
                />
                <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-coverage">
                  {props.t("context.flightRecorder.coverage", {
                    covered: value().covered.toString(),
                    total: value().total.toString(),
                  })}
                </div>
              </>
            )}
          </Show>
          <Show when={lowest()}>
            {(low) => (
              <button
                type="button"
                data-testid="flight-recorder-low-point"
                class="text-left text-11-regular text-text-weak truncate"
                onClick={() => {
                  setSelected(low().row.id)
                  revealDetail(low().row.id)
                }}
              >
                {props.t("context.flightRecorder.lowPoint", {
                  percent: format().percent(low().ratio * 100),
                  time: format().time(low().row.time),
                })}
              </button>
            )}
          </Show>
          <div class="flex items-baseline justify-between gap-2 text-11-regular">
            <span class="text-text-weak">{props.t("context.flightRecorder.cost")}</span>
            <span class="text-text-base text-right truncate" data-testid="flight-recorder-cost">
              {costs().covered === 0
                ? "—"
                : costs()
                    .items.map((item) =>
                      format().cost(
                        item.amount,
                        item.currency,
                        props.t("context.flightRecorder.currencyUnknown"),
                      ),
                    )
                    .join(" + ")}
            </span>
          </div>
          <Show when={costs().covered > 0}>
            <div class="text-11-regular text-text-weaker">
              {props.t("context.flightRecorder.costCoverage", {
                covered: costs().covered.toString(),
                total: costs().total.toString(),
              })}
            </div>
          </Show>
          <div class="text-11-regular text-text-weaker">{ratioNote()}</div>
        </div>

        <div class="flex flex-col gap-1">
          <For each={state.state.rows}>
            {(row) => {
              const previous = () => {
                const capture = row.diagnostics?.capture
                return capture?.status === "captured" && capture.previousRequestID
                  ? state.state.rows.find((item) => item.id === capture.previousRequestID)
                  : undefined
              }
              return (
                <FlightRecorderRowItem
                  row={row}
                  previous={previous()}
                  source={state.state.source}
                  t={props.t}
                  format={format()}
                  open={selected() === row.id}
                  onToggle={() => toggleRow(row.id)}
                />
              )
            }}
          </For>
        </div>

        <Show when={state.state.capped}>
          <div class="text-11-regular text-text-weaker" data-testid="flight-recorder-cap">
            {props.t("context.flightRecorder.cap", { count: (props.maxRows ?? FLIGHT_RECORDER_MAX_ROWS).toString() })}
          </div>
        </Show>
        <Show when={!state.state.capped && state.state.next}>
          <button
            type="button"
            data-testid="flight-recorder-load-more"
            class="self-start rounded-md bg-surface-base px-2 py-1 text-11-regular text-text-strong"
            disabled={state.state.loadingMore}
            onClick={() => void state.loadMore()}
          >
            {state.state.loadingMore
              ? props.t("context.flightRecorder.loadingMore")
              : props.t("context.flightRecorder.loadMore")}
          </button>
        </Show>
        <Show when={!state.state.capped && !state.state.next}>
          <div class="text-11-regular text-text-weaker">{props.t("context.flightRecorder.end")}</div>
        </Show>
      </Show>
    </div>
  )
}

export type FlightRecorderSectionProps = {
  sessionID: () => string | undefined
  loadPage: FlightRecorderLoad
  t: FlightRecorderTranslate
  locale: () => string
  pageSize?: number
  maxRows?: number
}

/** Context 面板中的入口。默认折叠；展开才挂载 FlightRecorderPanel，因此未开无请求。 */
export function FlightRecorderSection(props: FlightRecorderSectionProps) {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <div class="session-side-panel__summary-group">
      <CapsuleRow
        icon="terminal"
        data-testid="flight-recorder-toggle"
        selected={expanded()}
        aria-expanded={expanded()}
        aria-controls="session-context-flight-recorder"
        onClick={() => setExpanded((value) => !value)}
        trailing={
          <Icon
            name="chevron-down"
            size="small"
            class={expanded() ? "rotate-180 transition-transform" : "transition-transform"}
          />
        }
      >
        <div class="flex items-center justify-between gap-3 w-full min-w-0">
          <span class="text-12-regular text-text-weak shrink-0">{props.t("context.flightRecorder.title")}</span>
          <span class="text-12-regular text-text-base truncate" data-testid="flight-recorder-state">
            {expanded() ? props.t("context.flightRecorder.collapse") : props.t("context.flightRecorder.expand")}
          </span>
        </div>
      </CapsuleRow>
      <Show when={expanded()}>
        <div id="session-context-flight-recorder" class="px-2 pb-2 pt-1">
          <FlightRecorderPanel {...props} />
        </div>
      </Show>
    </div>
  )
}

/** 生产装配：SDK 契约 sdk.client.session.flightRecorder 由生成器提供，这里只做接线。 */
export function SessionFlightRecorderSection() {
  const sdk = useSDK()
  const language = useLanguage()
  const { params } = useSessionLayout()
  return (
    <FlightRecorderSection
      sessionID={() => params.id}
      loadPage={async ({ sessionID, source, before, limit }) => {
        const response = await sdk.client.session.flightRecorder(
          { sessionID, source, before, limit },
          { throwOnError: true },
        )
        if (!response.data) throw new Error("empty flight recorder response")
        return response.data
      }}
      t={(key, values) => language.t(key as Parameters<typeof language.t>[0], values)}
      locale={() => language.intl()}
    />
  )
}
