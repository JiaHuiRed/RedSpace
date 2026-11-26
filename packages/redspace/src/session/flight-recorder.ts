import { and, desc, eq, sql, type SQL } from "drizzle-orm"
import { Option, Schema } from "effect"
import type { WorkspaceID } from "@/control-plane/schema"
import type { ProjectID } from "@/project/schema"
import { Database } from "@/storage/db"
import { FlightRequestTable } from "./flight-request.sql"
import { Diagnostics, PrefixChange } from "./flight-recording"
import type { RequestData } from "./flight-recording"
import { stats as retentionStats } from "./flight-request-writer"
import type { SessionID } from "./schema"
import { MessageTable, PartTable, SessionTable } from "./session.sql"

// 261126 Red 账单步骤和实际请求分开分页，不能加总。见 docs/notes/implemented/feature/2026-11-26-flight-recorder.md
export const Source = Schema.Literals(["steps", "requests"])
export type Source = typeof Source.Type
export const MAX_PAGE = 50
// 261126 Red FR-04 全局扫描预算。两条查询都先按全局 (time_created,id) 索引取一个有界窗口
// （summary 窗口更大），再把项目/工作区/筛选取在窗口内。窗口用满时返回 next 游标继续，
// 不允许把「本窗口没命中」当成「不存在」。
export const GLOBAL_SCAN_LIMIT = 5_000
export const PAGE_SCAN_LIMIT = 1_000
export const MAX_GROUPS = 50
export const MAX_TREND_DAYS = 60
const metric = Schema.optional(Schema.Finite)
export const Row = Schema.Struct({
  id: Schema.String,
  messageID: Schema.String,
  time: Schema.Finite,
  providerID: Schema.String,
  modelID: Schema.String,
  outcome: Schema.Literals(["booked", "estimated", "completed", "failed", "cancelled", "unknown"]),
  summary: Schema.optional(Schema.Boolean),
  /** step-finish 自己记录的请求关联号（写入侧 ≤64）；旧记录没有该字段，不加入猜测性关联。 */
  requestID: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  input: metric,
  output: metric,
  cacheRead: metric,
  cacheWrite: metric,
  cacheMiss: metric,
  cost: metric,
  currency: Schema.optional(Schema.String),
  durationMs: metric,
  firstEventMs: metric,
  prefix: Schema.optional(
    Schema.Struct({ system: PrefixChange, tools: PrefixChange, history: PrefixChange, compressed: Schema.Boolean }),
  ),
  diagnostics: Schema.optional(Diagnostics),
}).annotate({ identifier: "FlightRecorderRow" })
export type Row = typeof Row.Type
export const Page = Schema.Struct({
  items: Schema.Array(Row),
  next: Schema.optional(Schema.String),
}).annotate({ identifier: "FlightRecorderPage" })
export type Page = typeof Page.Type

// 261126 Red 全局观测的契约。两本账分别汇总，不合并计数；费用只出现在 steps 账本且按币种
// 分桶，缺报只计 missing，不换算、不补零。命中率的 Σread/Σinput 只取有效样本。
export const Percentiles = Schema.Struct({
  p50: Schema.optional(Schema.Finite),
  p95: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
}).annotate({ identifier: "FlightRecorderPercentiles" })
export type Percentiles = typeof Percentiles.Type

export const CacheStats = Schema.Struct({
  /** Σinput，仅含有效命中率样本（input/cacheRead 有限、非负且 read ≤ input）。 */
  input: Schema.Finite,
  /** ΣcacheRead，与 input 同一批有效样本。 */
  read: Schema.Finite,
  samples: Schema.Int,
  /** read / input；没有正分母时缺省，不伪造 0 或 100%。 */
  hitRate: Schema.optional(Schema.Finite),
  excluded: Schema.Struct({
    /** 有值但矛盾：负数，或 cacheRead 大于 input。 */
    invalid: Schema.Int,
    /** 缺 input 或 cacheRead；缺报不是命中率 0。 */
    incomplete: Schema.Int,
  }),
}).annotate({ identifier: "FlightRecorderCacheStats" })
export type CacheStats = typeof CacheStats.Type

export const UsageStats = Schema.Struct({
  samples: Schema.Int,
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cacheMiss: Schema.Finite,
  cache: CacheStats,
}).annotate({ identifier: "FlightRecorderUsage" })
export type UsageStats = typeof UsageStats.Type

export const CostBucket = Schema.Struct({
  /** null = 行上没有币种；不按其他币种折算。 */
  currency: Schema.NullOr(Schema.String),
  booked: Schema.Finite,
  /** steps 账本里 estimated 标记单独列出，不混入 booked。 */
  estimated: Schema.Finite,
  /** 有有限 cost 的行数（booked + estimated）。 */
  samples: Schema.Int,
  /** 没有 cost 的行数；缺失不是 0。 */
  missing: Schema.Int,
}).annotate({ identifier: "FlightRecorderCostBucket" })
export type CostBucket = typeof CostBucket.Type

export const StepSummary = Schema.Struct({
  samples: Schema.Int,
  /** 去重后的会话数；main = 无 parent_id，sub = 由父会话派生。 */
  sessions: Schema.Struct({ main: Schema.Int, sub: Schema.Int }),
  usage: UsageStats,
  outcomes: Schema.Struct({ booked: Schema.Int, estimated: Schema.Int }),
  cost: Schema.Array(CostBucket),
}).annotate({ identifier: "FlightRecorderStepSummary" })
export type StepSummary = typeof StepSummary.Type

export const RequestSummary = Schema.Struct({
  samples: Schema.Int,
  sessions: Schema.Struct({ main: Schema.Int, sub: Schema.Int }),
  usage: UsageStats,
  /** 每次可观察的尝试各自计数；不推断重试次数，也不与 steps 强行一一对应。 */
  outcomes: Schema.Struct({
    completed: Schema.Int,
    failed: Schema.Int,
    cancelled: Schema.Int,
    unknown: Schema.Int,
  }),
  latency: Schema.Struct({
    samples: Schema.Int,
    durationMs: Percentiles,
    firstEventMs: Percentiles,
  }),
}).annotate({ identifier: "FlightRecorderRequestSummary" })
export type RequestSummary = typeof RequestSummary.Type

export const Coverage = Schema.Struct({
  /** 本作用域命中行里最旧 / 最新的时间；truncated 时 from 之外是未知，不是历史起点。 */
  from: Schema.optional(Schema.Finite),
  to: Schema.optional(Schema.Finite),
  /** 本次实际检查的全局索引行数；可能包含其他项目或被 provider/workspace 筛掉的行。 */
  scanned: Schema.Int,
  truncated: Schema.Boolean,
}).annotate({ identifier: "FlightRecorderCoverage" })
export type Coverage = typeof Coverage.Type

export const GlobalSummary = Schema.Struct({
  from: Schema.optional(Schema.Finite),
  to: Schema.optional(Schema.Finite),
  steps: StepSummary,
  requests: RequestSummary,
  ownership: Schema.Struct({
    steps: Schema.Struct({ main: UsageStats, sub: UsageStats }),
    requests: Schema.Struct({ main: UsageStats, sub: UsageStats }),
  }),
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      steps: StepSummary,
      requests: RequestSummary,
    }),
  ),
  workspaces: Schema.Array(
    Schema.Struct({
      workspaceID: Schema.NullOr(Schema.String),
      steps: StepSummary,
      requests: RequestSummary,
    }),
  ),
  daily: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      steps: StepSummary,
      requests: RequestSummary,
    }),
  ),
  coverage: Schema.Struct({ steps: Coverage, requests: Coverage }),
  /** 扫描预算用尽：更旧的行没有检查，统计只覆盖当前窗口。 */
  truncated: Schema.Boolean,
  /** 有窗口用满时出现；按账本续查（只包含未扫完的账本）。统计是窗口局部值。 */
  next: Schema.optional(Schema.String),
  /** models/workspaces/daily 至少一个被 MAX_GROUPS/MAX_TREND_DAYS 截断。 */
  breakdownsTruncated: Schema.Boolean,
  limits: Schema.Struct({
    /** summary 每个账本每次最多检查的索引行数。 */
    scan: Schema.Int,
    /** rows 每次最多检查的索引行数。旧调用方 fixture 可以不带，服务端响应始终有值。 */
    pageScan: Schema.optional(Schema.Int),
    groups: Schema.Int,
    trendDays: Schema.Int,
  }),
  retention: Schema.Struct({
    /** 当前生效的每会话保留行数。 */
    requestsPerSession: Schema.Int,
    /** 当前生效的全局保留行数（默认 100000）。旧 fixture 可以不带，服务端响应始终有值。 */
    totalRequests: Schema.optional(Schema.Int),
    /** 年龄保留上限（毫秒）；未启用时缺省。 */
    retentionMs: Schema.optional(Schema.Int),
  }),
}).annotate({ identifier: "FlightRecorderGlobalSummary" })
export type GlobalSummary = typeof GlobalSummary.Type

export const GlobalRow = Schema.Struct({
  ...Row.fields,
  sessionID: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  /** true = 该行属于有 parent_id 的子会话。每行只归属一个会话。 */
  sub: Schema.Boolean,
}).annotate({ identifier: "FlightRecorderGlobalRow" })
export type GlobalRow = typeof GlobalRow.Type

export const GlobalPage = Schema.Struct({
  items: Schema.Array(GlobalRow),
  next: Schema.optional(Schema.String),
  /** 本次实际检查的全局索引行数（项目/工作区/provider/model/detached 过滤之前），受 PAGE_SCAN_LIMIT 约束。 */
  scanned: Schema.Int,
  /** 返回行数少于 limit 且扫描窗口已满：更旧的行里可能还有匹配项，继续跟随 next。 */
  truncated: Schema.Boolean,
}).annotate({ identifier: "FlightRecorderGlobalPage" })
export type GlobalPage = typeof GlobalPage.Type

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    sessionID: Schema.String,
    source: Source,
    time: Schema.Int,
    id: Schema.NonEmptyString,
  }),
)
const decode = Schema.decodeUnknownOption(Cursor)
const encode = Schema.encodeSync(Cursor)
type Cursor = typeof Cursor.Type

export function page(
  sessionID: SessionID,
  scope: GlobalScope,
  source: Source,
  limit = 20,
  before?: string,
): Page | undefined {
  const cursor = before === undefined ? undefined : Option.getOrUndefined(decode(before))
  if (before !== undefined && (!cursor || cursor.sessionID !== sessionID || cursor.source !== source)) return
  const rows =
    source === "steps" ? steps(sessionID, scope, limit + 1, cursor) : requests(sessionID, scope, limit + 1, cursor)
  if (rows.length <= limit) return { items: rows }
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return { items, next: encode({ sessionID, source, time: last.time, id: last.id }) }
}

const visible = sql`ifnull(json_extract(${MessageTable.data}, '$.detached'), 0) = 0`
const summaryFlag = sql<number | null>`json_extract(${MessageTable.data}, '$.summary')`

function steps(sessionID: SessionID, scope: GlobalScope, limit: number, cursor?: Cursor): Row[] {
  const p = PartTable
  const rows = Database.use((db) =>
    db
      .select({
        id: p.id,
        messageID: p.message_id,
        time: p.time_created,
        summary: summaryFlag,
        providerID: sql<string>`coalesce(substr(json_extract(${MessageTable.data}, '$.providerID'), 1, 256), '')`,
        modelID: sql<string>`coalesce(substr(json_extract(${MessageTable.data}, '$.modelID'), 1, 256), '')`,
        requestID: sql<string | null>`json_extract(${p.data}, '$.requestID')`,
        cost: sql<number | null>`json_extract(${p.data}, '$.cost')`,
        currency: sql<string | null>`json_extract(${p.data}, '$.currency')`,
        estimated: sql<number | null>`json_extract(${p.data}, '$.estimated')`,
        input: sql<number | null>`json_extract(${p.data}, '$.tokens.context')`,
        output: sql<
          number | null
        >`json_extract(${p.data}, '$.tokens.output') + ifnull(json_extract(${p.data}, '$.tokens.reasoning'), 0)`,
        cacheRead: sql<number | null>`json_extract(${p.data}, '$.tokens.cache.read')`,
        cacheWrite: sql<number | null>`json_extract(${p.data}, '$.tokens.cache.write')`,
        cacheMiss: sql<number | null>`json_extract(${p.data}, '$.tokens.cache.miss')`,
      })
      .from(p)
      .innerJoin(MessageTable, eq(p.message_id, MessageTable.id))
      .innerJoin(SessionTable, eq(p.session_id, SessionTable.id))
      .where(
        and(
          eq(p.session_id, sessionID),
          eq(MessageTable.session_id, sessionID),
          eq(SessionTable.project_id, scope.projectID),
          scope.workspaceID !== undefined ? eq(SessionTable.workspace_id, scope.workspaceID) : undefined,
          visible,
          sql`json_extract(${p.data}, '$.type') = 'step-finish'`,
          cursor && sql`(${p.time_created}, ${p.id}) < (${cursor.time}, ${cursor.id})`,
        ),
      )
      .orderBy(desc(p.time_created), desc(p.id))
      .limit(limit)
      .all(),
  )

  return rows.map((row) => ({
    id: row.id,
    messageID: row.messageID,
    time: row.time,
    providerID: row.providerID,
    modelID: row.modelID,
    outcome: row.estimated ? "estimated" : "booked",
    summary: row.summary ? true : undefined,
    requestID: row.requestID ?? undefined,
    cost: row.cost ?? undefined,
    currency: row.currency ?? undefined,
    output: row.output ?? undefined,
    // 估算只补输出。旧账缺 tokens.context 时不能用未经钳制的缓存读写反推总输入。
    input: row.estimated ? undefined : (row.input ?? undefined),
    cacheRead: row.estimated ? undefined : (row.cacheRead ?? undefined),
    cacheWrite: row.estimated ? undefined : (row.cacheWrite ?? undefined),
    cacheMiss: row.estimated ? undefined : (row.cacheMiss ?? undefined),
  }))
}

function requests(sessionID: SessionID, scope: GlobalScope, limit: number, cursor?: Cursor): Row[] {
  const r = FlightRequestTable
  return Database.use((db) =>
    db
      .select({
        id: r.id,
        messageID: r.message_id,
        time: r.time_created,
        providerID: r.provider_id,
        modelID: r.model_id,
        data: r.data,
        summary: summaryFlag,
      })
      .from(r)
      .innerJoin(MessageTable, eq(r.message_id, MessageTable.id))
      .innerJoin(SessionTable, eq(r.session_id, SessionTable.id))
      .where(
        and(
          eq(r.session_id, sessionID),
          eq(MessageTable.session_id, sessionID),
          eq(SessionTable.project_id, scope.projectID),
          scope.workspaceID !== undefined ? eq(SessionTable.workspace_id, scope.workspaceID) : undefined,
          visible,
          cursor && sql`(${r.time_created}, ${r.id}) < (${cursor.time}, ${cursor.id})`,
        ),
      )
      .orderBy(desc(r.time_created), desc(r.id))
      .limit(limit)
      .all(),
  ).map(({ data, summary, ...row }) => ({ ...row, ...data, summary: summary ? true : undefined }))
}

// ---------------------------------------------------------------------------
// 261126 Red 全局观测（FR-04）：同一套双账本，跨会话有界聚合与分页。
// 作用域由调用方从 InstanceState 解析；本模块不接受项目参数，避免查询越权。
// ---------------------------------------------------------------------------

export type GlobalScope = {
  readonly projectID: ProjectID
  readonly workspaceID?: WorkspaceID
}

export type GlobalFilters = {
  readonly from?: number
  readonly to?: number
  readonly providerID?: string
  readonly modelID?: string
  readonly sessionID?: SessionID
  readonly workspaceID?: WorkspaceID
}

const ScanCursor = Schema.Struct({ time: Schema.Int, id: Schema.NonEmptyString })
type ScanCursor = typeof ScanCursor.Type

// 作用域与全部筛选都进游标：换项目、换工作区或换筛选后不能复用旧页/旧续扫地。
const CursorIdentity = {
  projectID: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  from: Schema.optional(Schema.Int),
  to: Schema.optional(Schema.Int),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  workspaceFilter: Schema.optional(Schema.String),
}

const GlobalCursor = Schema.fromJsonString(
  Schema.Struct({
    ...CursorIdentity,
    source: Source,
    time: Schema.Int,
    id: Schema.NonEmptyString,
  }),
)
const decodeGlobal = Schema.decodeUnknownOption(GlobalCursor)
const encodeGlobal = Schema.encodeSync(GlobalCursor)
type GlobalCursor = typeof GlobalCursor.Type

// summary 的续查游标按账本分开。只包含未扫完的账本；缺失的账本表示本次不扫（已完成）。
const SummaryCursor = Schema.fromJsonString(
  Schema.Struct({
    ...CursorIdentity,
    steps: Schema.optional(ScanCursor),
    requests: Schema.optional(ScanCursor),
  }),
)
const decodeSummary = Schema.decodeUnknownOption(SummaryCursor)
const encodeSummary = Schema.encodeSync(SummaryCursor)
type SummaryCursor = typeof SummaryCursor.Type

const finite = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const nonNegative = (value: number | undefined): number | undefined =>
  value !== undefined && value >= 0 ? value : undefined
const currency = (value: string | null | undefined) => (typeof value === "string" ? value : undefined)
const outcomeOf = (value: unknown): "completed" | "failed" | "cancelled" | "unknown" =>
  value === "completed" || value === "failed" || value === "cancelled" ? value : "unknown"

const localDay = (timestamp: number) => {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

type WindowRow = {
  id: string
  sessionID: string
  messageID: string
  time: number
  projectID: string
  workspaceID: string | null
  parentID: string | null
  providerID: string
  modelID: string
  /** json_extract 的 0/1；null = 消息没写 detached。 */
  detached: number | null
  summary: number | null
}

type StepRow = WindowRow & {
  estimated: boolean
  requestID?: string
  cost?: number
  currency?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheMiss?: number
}

type RequestRow = WindowRow & {
  outcome: "completed" | "failed" | "cancelled" | "unknown"
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheMiss?: number
  durationMs?: number
  firstEventMs?: number
  prefix?: Row["prefix"]
  diagnostics?: Row["diagnostics"]
}

// 261126 Red FR-04 扫描形状：内层按全局 (time_created,id) 索引取一个 MATERIALIZED 窗口，
// 外层 join 只补 session/message 元数据；项目/工作区/provider/model/会话/detached 的过滤
// 都在窗口内完成。窗口用满时返回 next 游标继续，不把「本窗口没命中」当成「历史里没有」。
// MATERIALIZED 是硬约束：否则优化器可能把外层过滤下推进内层，LIMIT 后的检查行数又变成无界。
type StepSQLRow = {
  id: string
  session_id: string
  message_id: string
  time: number
  project_id: string
  workspace_id: string | null
  parent_id: string | null
  provider_id: string
  model_id: string
  detached: number | null
  summary: number | null
  request_id: string | null
  cost: number | null
  currency: string | null
  estimated: number | null
  input: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  cache_miss: number | null
}

// 261126 Red FR-04 作用域索引：窗口只从 flight_scope 取当前 project/workspace 的可见行。
// 其他项目/工作区的行既不进入 LIMIT，也不进入 cursor/coverage/scanned；provider/model/
// session 这些收窄筛选在窗口内完成，不会反向扩大授权范围。
function scopeConditions(scope: GlobalScope, filters: GlobalFilters, kind: "step" | "request") {
  const conditions = [sql`sc.project_id = ${scope.projectID}`, sql`sc.kind = ${kind}`, sql`sc.visible = 1`]
  if (scope.workspaceID !== undefined) conditions.push(sql`sc.workspace_id = ${scope.workspaceID}`)
  if (filters.workspaceID !== undefined && filters.workspaceID !== scope.workspaceID) {
    conditions.push(sql`sc.workspace_id = ${filters.workspaceID}`)
  }
  if (filters.sessionID !== undefined) conditions.push(sql`sc.session_id = ${filters.sessionID}`)
  if (filters.from !== undefined) conditions.push(sql`sc.time_created >= ${filters.from}`)
  if (filters.to !== undefined) conditions.push(sql`sc.time_created < ${filters.to}`)
  return conditions
}

function scanSteps(
  scope: GlobalScope,
  filters: GlobalFilters,
  cursor: ScanCursor | undefined,
  budget: number,
): StepRow[] {
  const conditions = scopeConditions(scope, filters, "step")
  if (cursor !== undefined) conditions.push(sql`(sc.time_created, sc.id) < (${cursor.time}, ${cursor.id})`)
  const rows = Database.use((db) =>
    db.all<StepSQLRow>(sql`
      with window_rows as materialized (
        select sc.id as id, sc.session_id as session_id, sc.message_id as message_id,
               sc.time_created as time
        from flight_scope sc
        where ${sql.join(conditions, sql` and `)}
        order by sc.time_created desc, sc.id desc
        limit ${budget}
      )
      select w.id as id, w.session_id as session_id, w.message_id as message_id,
             w.time as time,
             s.project_id as project_id, s.workspace_id as workspace_id, s.parent_id as parent_id,
             coalesce(substr(json_extract(m.data, '$.providerID'), 1, 256), '') as provider_id,
             coalesce(substr(json_extract(m.data, '$.modelID'), 1, 256), '') as model_id,
             json_extract(m.data, '$.detached') as detached,
             json_extract(m.data, '$.summary') as summary,
             json_extract(p.data, '$.requestID') as request_id,
             json_extract(p.data, '$.cost') as cost,
             json_extract(p.data, '$.currency') as currency,
             json_extract(p.data, '$.estimated') as estimated,
             json_extract(p.data, '$.tokens.context') as input,
             json_extract(p.data, '$.tokens.output') + ifnull(json_extract(p.data, '$.tokens.reasoning'), 0) as output,
             json_extract(p.data, '$.tokens.cache.read') as cache_read,
             json_extract(p.data, '$.tokens.cache.write') as cache_write,
             json_extract(p.data, '$.tokens.cache.miss') as cache_miss
      from window_rows w
      join part p on p.id = w.id
      join session s on s.id = w.session_id
      join message m on m.id = w.message_id
      order by w.time desc, w.id desc
    `),
  )

  return rows.map((row) => {
    const estimated = Boolean(row.estimated)
    const input = estimated ? undefined : finite(row.input)
    const cacheRead = estimated ? undefined : finite(row.cache_read)
    const cacheWrite = estimated ? undefined : finite(row.cache_write)
    const cacheMiss = estimated ? undefined : finite(row.cache_miss)
    const cost = finite(row.cost)
    const unit = currency(row.currency)
    const output = finite(row.output)
    return {
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
      time: row.time,
      projectID: row.project_id,
      workspaceID: row.workspace_id,
      parentID: row.parent_id,
      providerID: row.provider_id,
      modelID: row.model_id,
      detached: row.detached,
      summary: row.summary,
      estimated,
      ...(row.request_id === null ? {} : { requestID: row.request_id }),
      ...(cost === undefined ? {} : { cost }),
      ...(unit === undefined ? {} : { currency: unit }),
      ...(input === undefined ? {} : { input }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(cacheMiss === undefined ? {} : { cacheMiss }),
      ...(output === undefined ? {} : { output }),
    }
  })
}

type RequestSQLRow = {
  id: string
  session_id: string
  message_id: string
  time: number
  project_id: string
  workspace_id: string | null
  parent_id: string | null
  provider_id: string
  model_id: string
  detached: number | null
  summary: number | null
  data: string
}

function scanRequests(
  scope: GlobalScope,
  filters: GlobalFilters,
  cursor: ScanCursor | undefined,
  budget: number,
): RequestRow[] {
  const conditions = scopeConditions(scope, filters, "request")
  if (cursor !== undefined) conditions.push(sql`(sc.time_created, sc.id) < (${cursor.time}, ${cursor.id})`)
  const rows = Database.use((db) =>
    db.all<RequestSQLRow>(sql`
      with window_rows as materialized (
        select sc.id as id, sc.session_id as session_id, sc.message_id as message_id,
               sc.time_created as time
        from flight_scope sc
        where ${sql.join(conditions, sql` and `)}
        order by sc.time_created desc, sc.id desc
        limit ${budget}
      )
      select w.id as id, w.session_id as session_id, w.message_id as message_id,
             w.time as time, r.provider_id as provider_id, r.model_id as model_id,
             s.project_id as project_id, s.workspace_id as workspace_id, s.parent_id as parent_id,
             json_extract(m.data, '$.detached') as detached,
             json_extract(m.data, '$.summary') as summary,
             r.data as data
      from window_rows w
      join flight_request r on r.id = w.id
      join session s on s.id = w.session_id
      join message m on m.id = w.message_id
      order by w.time desc, w.id desc
    `),
  )

  return rows.map((row) => {
    const data = JSON.parse(row.data) as RequestData
    const input = finite(data.input)
    const output = finite(data.output)
    const cacheRead = finite(data.cacheRead)
    const cacheWrite = finite(data.cacheWrite)
    const cacheMiss = finite(data.cacheMiss)
    const durationMs = finite(data.durationMs)
    const firstEventMs = finite(data.firstEventMs)
    return {
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
      time: row.time,
      projectID: row.project_id,
      workspaceID: row.workspace_id,
      parentID: row.parent_id,
      providerID: row.provider_id,
      modelID: row.model_id,
      detached: row.detached,
      summary: row.summary,
      outcome: outcomeOf(data.outcome),
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(cacheMiss === undefined ? {} : { cacheMiss }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(firstEventMs === undefined ? {} : { firstEventMs }),
      ...(data.prefix === undefined ? {} : { prefix: data.prefix }),
      ...(data.diagnostics === undefined ? {} : { diagnostics: data.diagnostics }),
    }
  })
}

const inScope = (row: WindowRow, scope: GlobalScope, filters: GlobalFilters) =>
  row.projectID === scope.projectID &&
  (scope.workspaceID === undefined || row.workspaceID === scope.workspaceID) &&
  (filters.workspaceID === undefined || row.workspaceID === filters.workspaceID) &&
  (filters.sessionID === undefined || row.sessionID === filters.sessionID) &&
  (filters.providerID === undefined || row.providerID === filters.providerID) &&
  (filters.modelID === undefined || row.modelID === filters.modelID) &&
  !row.detached

const sameCursorScope = (
  cursor: {
    projectID: string
    workspaceID?: string
    from?: number
    to?: number
    providerID?: string
    modelID?: string
    sessionID?: string
    workspaceFilter?: string
  },
  scope: GlobalScope,
  filters: GlobalFilters,
) =>
  cursor.projectID === scope.projectID &&
  cursor.workspaceID === scope.workspaceID &&
  cursor.from === filters.from &&
  cursor.to === filters.to &&
  cursor.providerID === filters.providerID &&
  cursor.modelID === filters.modelID &&
  cursor.sessionID === filters.sessionID &&
  cursor.workspaceFilter === filters.workspaceID
function stepGlobalRow(row: StepRow): GlobalRow {
  return {
    id: row.id,
    messageID: row.messageID,
    time: row.time,
    providerID: row.providerID,
    modelID: row.modelID,
    outcome: row.estimated ? "estimated" : "booked",
    ...(row.summary ? { summary: true } : {}),
    ...(row.requestID === undefined ? {} : { requestID: row.requestID }),
    ...(row.cost === undefined ? {} : { cost: row.cost }),
    ...(row.currency === undefined ? {} : { currency: row.currency }),
    ...(row.output === undefined ? {} : { output: row.output }),
    ...(row.input === undefined ? {} : { input: row.input }),
    ...(row.cacheRead === undefined ? {} : { cacheRead: row.cacheRead }),
    ...(row.cacheWrite === undefined ? {} : { cacheWrite: row.cacheWrite }),
    ...(row.cacheMiss === undefined ? {} : { cacheMiss: row.cacheMiss }),
    sessionID: row.sessionID,
    ...(row.workspaceID === null ? {} : { workspaceID: row.workspaceID }),
    sub: row.parentID !== null,
  }
}

function requestGlobalRow(row: RequestRow): GlobalRow {
  return {
    id: row.id,
    messageID: row.messageID,
    time: row.time,
    providerID: row.providerID,
    modelID: row.modelID,
    outcome: row.outcome,
    ...(row.summary ? { summary: true } : {}),
    ...(row.input === undefined ? {} : { input: row.input }),
    ...(row.output === undefined ? {} : { output: row.output }),
    ...(row.cacheRead === undefined ? {} : { cacheRead: row.cacheRead }),
    ...(row.cacheWrite === undefined ? {} : { cacheWrite: row.cacheWrite }),
    ...(row.cacheMiss === undefined ? {} : { cacheMiss: row.cacheMiss }),
    ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
    ...(row.firstEventMs === undefined ? {} : { firstEventMs: row.firstEventMs }),
    ...(row.prefix === undefined ? {} : { prefix: row.prefix }),
    ...(row.diagnostics === undefined ? {} : { diagnostics: row.diagnostics }),
    sessionID: row.sessionID,
    ...(row.workspaceID === null ? {} : { workspaceID: row.workspaceID }),
    sub: row.parentID !== null,
  }
}

function globalPageOf<R extends WindowRow>(
  rows: R[],
  matches: R[],
  limit: number,
  row: (value: R) => GlobalRow,
  next: (value: ScanCursor) => string,
): GlobalPage {
  const items = matches.slice(0, limit)
  const full = rows.length === PAGE_SCAN_LIMIT
  // 匹配超过本页时只能从最后一条已返回行续翻（窗口尾部还有已检查但未返回的匹配）；
  // 否则从最后一条已检查行续翻，保证空页/不足页也不会漏掉更老的数据。
  const boundary = matches.length > limit ? items[items.length - 1] : rows[rows.length - 1]
  return {
    items: items.map(row),
    ...(matches.length > limit || full ? (boundary ? { next: next(boundary) } : {}) : {}),
    scanned: rows.length,
    truncated: matches.length <= limit && full,
  }
}

export function pageGlobal(
  scope: GlobalScope,
  filters: GlobalFilters,
  source: Source,
  limit = 20,
  before?: string,
): GlobalPage | undefined {
  const cursor = before === undefined ? undefined : Option.getOrUndefined(decodeGlobal(before))
  if (before !== undefined && (!cursor || cursor.source !== source || !sameCursorScope(cursor, scope, filters))) return
  const next = (row: ScanCursor) =>
    encodeGlobal({
      projectID: scope.projectID,
      workspaceID: scope.workspaceID,
      source,
      from: filters.from,
      to: filters.to,
      providerID: filters.providerID,
      modelID: filters.modelID,
      sessionID: filters.sessionID,
      workspaceFilter: filters.workspaceID,
      time: row.time,
      id: row.id,
    })

  if (source === "steps") {
    const rows = scanSteps(scope, filters, cursor, PAGE_SCAN_LIMIT)
    return globalPageOf(
      rows,
      rows.filter((row) => inScope(row, scope, filters)),
      limit,
      stepGlobalRow,
      next,
    )
  }
  const rows = scanRequests(scope, filters, cursor, PAGE_SCAN_LIMIT)
  return globalPageOf(
    rows,
    rows.filter((row) => inScope(row, scope, filters)),
    limit,
    requestGlobalRow,
    next,
  )
}

type UsageTotals = {
  samples: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheMiss: number
  cacheInput: number
  cacheReadValid: number
  cacheSamples: number
  cacheInvalid: number
  cacheIncomplete: number
}

const emptyUsage = (): UsageTotals => ({
  samples: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheMiss: 0,
  cacheInput: 0,
  cacheReadValid: 0,
  cacheSamples: 0,
  cacheInvalid: 0,
  cacheIncomplete: 0,
})

function addUsage(
  total: UsageTotals,
  row: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cacheMiss?: number
  },
) {
  total.samples += 1
  total.input += nonNegative(row.input) ?? 0
  total.output += nonNegative(row.output) ?? 0
  total.cacheRead += nonNegative(row.cacheRead) ?? 0
  total.cacheWrite += nonNegative(row.cacheWrite) ?? 0
  total.cacheMiss += nonNegative(row.cacheMiss) ?? 0
  if (row.input === undefined || row.cacheRead === undefined) {
    total.cacheIncomplete += 1
    return
  }
  if (row.input < 0 || row.cacheRead < 0 || row.cacheRead > row.input) {
    total.cacheInvalid += 1
    return
  }
  total.cacheInput += row.input
  total.cacheReadValid += row.cacheRead
  total.cacheSamples += 1
}

const finishUsage = (total: UsageTotals): UsageStats => ({
  samples: total.samples,
  input: total.input,
  output: total.output,
  cacheRead: total.cacheRead,
  cacheWrite: total.cacheWrite,
  cacheMiss: total.cacheMiss,
  cache: {
    input: total.cacheInput,
    read: total.cacheReadValid,
    samples: total.cacheSamples,
    ...(total.cacheInput > 0 ? { hitRate: total.cacheReadValid / total.cacheInput } : {}),
    excluded: { invalid: total.cacheInvalid, incomplete: total.cacheIncomplete },
  },
})

type CostTotals = {
  currency: string | null
  booked: number
  estimated: number
  samples: number
  missing: number
}

type StepTotals = {
  samples: number
  main: Set<string>
  sub: Set<string>
  usage: UsageTotals
  booked: number
  estimated: number
  cost: Map<string | null, CostTotals>
}

const emptySteps = (): StepTotals => ({
  samples: 0,
  main: new Set(),
  sub: new Set(),
  usage: emptyUsage(),
  booked: 0,
  estimated: 0,
  cost: new Map(),
})

function addStep(total: StepTotals, row: StepRow) {
  total.samples += 1
  const sessions = row.parentID !== null ? total.sub : total.main
  sessions.add(row.sessionID)
  addUsage(total.usage, row)
  if (row.estimated) total.estimated += 1
  else total.booked += 1
  const unit = row.currency ?? null
  const bucket = bucketOf(total.cost, unit, () => ({ currency: unit, booked: 0, estimated: 0, samples: 0, missing: 0 }))
  if (row.cost === undefined) {
    bucket.missing += 1
    return
  }
  bucket.samples += 1
  if (row.estimated) bucket.estimated += row.cost
  else bucket.booked += row.cost
}

const finishSteps = (total?: StepTotals): StepSummary => ({
  samples: total?.samples ?? 0,
  sessions: { main: total?.main.size ?? 0, sub: total?.sub.size ?? 0 },
  usage: finishUsage(total?.usage ?? emptyUsage()),
  outcomes: { booked: total?.booked ?? 0, estimated: total?.estimated ?? 0 },
  cost: [...(total?.cost.values() ?? [])]
    .map((bucket) => ({ ...bucket }))
    .sort(
      (a, b) => b.booked + b.estimated - (a.booked + a.estimated) || (a.currency ?? "").localeCompare(b.currency ?? ""),
    ),
})

type RequestTotals = {
  samples: number
  main: Set<string>
  sub: Set<string>
  usage: UsageTotals
  completed: number
  failed: number
  cancelled: number
  unknown: number
  durations: number[]
  firstEvents: number[]
}

const emptyRequests = (): RequestTotals => ({
  samples: 0,
  main: new Set(),
  sub: new Set(),
  usage: emptyUsage(),
  completed: 0,
  failed: 0,
  cancelled: 0,
  unknown: 0,
  durations: [],
  firstEvents: [],
})

function addRequest(total: RequestTotals, row: RequestRow) {
  total.samples += 1
  const sessions = row.parentID !== null ? total.sub : total.main
  sessions.add(row.sessionID)
  addUsage(total.usage, row)
  total[row.outcome] += 1
  const duration = nonNegative(row.durationMs)
  if (duration !== undefined) total.durations.push(duration)
  const firstEvent = nonNegative(row.firstEventMs)
  if (firstEvent !== undefined) total.firstEvents.push(firstEvent)
}

function percentile(sorted: number[], value: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(value * sorted.length) - 1))]!
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return {}
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1]! }
}

const finishRequests = (total?: RequestTotals): RequestSummary => ({
  samples: total?.samples ?? 0,
  sessions: { main: total?.main.size ?? 0, sub: total?.sub.size ?? 0 },
  usage: finishUsage(total?.usage ?? emptyUsage()),
  outcomes: {
    completed: total?.completed ?? 0,
    failed: total?.failed ?? 0,
    cancelled: total?.cancelled ?? 0,
    unknown: total?.unknown ?? 0,
  },
  latency: {
    samples: total?.durations.length ?? 0,
    durationMs: percentiles(total?.durations ?? []),
    firstEventMs: percentiles(total?.firstEvents ?? []),
  },
})

function bucketOf<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const found = map.get(key)
  if (found !== undefined) return found
  const value = create()
  map.set(key, value)
  return value
}

function modelBucket<B>(
  map: Map<string, { providerID: string; modelID: string; value: B }>,
  row: { providerID: string; modelID: string },
  create: () => B,
): B {
  const key = `${row.providerID}\u0000${row.modelID}`
  const found = map.get(key)
  if (found !== undefined) return found.value
  const value = create()
  map.set(key, { providerID: row.providerID, modelID: row.modelID, value })
  return value
}

// from/to 只取本作用域命中行，避免把其他项目的活动时间漏给当前实例；scanned 仍是本次实际
// 检查的全局索引行数，调用方据此知道预算消耗。
const coverageOf = (examined: number, truncated: boolean, rows: { time: number }[]): Coverage => ({
  ...(rows.length === 0 ? {} : { from: rows[rows.length - 1]!.time, to: rows[0]!.time }),
  scanned: examined,
  truncated,
})

const sampleTotal = (group: { steps: StepSummary; requests: RequestSummary }) =>
  group.steps.samples + group.requests.samples

const scanBoundary = (rows: { time: number; id: string }[]): ScanCursor | undefined => {
  const last = rows[rows.length - 1]
  return last === undefined ? undefined : { time: last.time, id: last.id }
}

export function overview(scope: GlobalScope, filters: GlobalFilters = {}, before?: string): GlobalSummary | undefined {
  const cursor = before === undefined ? undefined : Option.getOrUndefined(decodeSummary(before))
  if (before !== undefined && (!cursor || !sameCursorScope(cursor, scope, filters))) return
  if (cursor !== undefined && cursor.steps === undefined && cursor.requests === undefined) return
  // 续查时只扫 next 里带上的账本；没带的账本本次不扫（空统计 + scanned=0）。
  const scanStepLedger = cursor === undefined || cursor.steps !== undefined
  const scanRequestLedger = cursor === undefined || cursor.requests !== undefined
  const stepScan = scanStepLedger ? scanSteps(scope, filters, cursor?.steps, GLOBAL_SCAN_LIMIT) : []
  const requestScan = scanRequestLedger ? scanRequests(scope, filters, cursor?.requests, GLOBAL_SCAN_LIMIT) : []
  const stepFull = stepScan.length === GLOBAL_SCAN_LIMIT
  const requestFull = requestScan.length === GLOBAL_SCAN_LIMIT
  const stepRows = stepScan.filter((row) => inScope(row, scope, filters))
  const requestRows = requestScan.filter((row) => inScope(row, scope, filters))

  const steps = emptySteps()
  const requests = emptyRequests()
  const ownership = {
    steps: { main: emptyUsage(), sub: emptyUsage() },
    requests: { main: emptyUsage(), sub: emptyUsage() },
  }
  const stepModels = new Map<string, { providerID: string; modelID: string; value: StepTotals }>()
  const requestModels = new Map<string, { providerID: string; modelID: string; value: RequestTotals }>()
  const stepWorkspaces = new Map<string | null, StepTotals>()
  const requestWorkspaces = new Map<string | null, RequestTotals>()
  const stepDays = new Map<string, StepTotals>()
  const requestDays = new Map<string, RequestTotals>()

  for (const row of stepRows) {
    addStep(steps, row)
    addUsage(row.parentID !== null ? ownership.steps.sub : ownership.steps.main, row)
    addStep(modelBucket(stepModels, row, emptySteps), row)
    addStep(bucketOf(stepWorkspaces, row.workspaceID, emptySteps), row)
    addStep(bucketOf(stepDays, localDay(row.time), emptySteps), row)
  }
  for (const row of requestRows) {
    addRequest(requests, row)
    addUsage(row.parentID !== null ? ownership.requests.sub : ownership.requests.main, row)
    addRequest(modelBucket(requestModels, row, emptyRequests), row)
    addRequest(bucketOf(requestWorkspaces, row.workspaceID, emptyRequests), row)
    addRequest(bucketOf(requestDays, localDay(row.time), emptyRequests), row)
  }

  const models = [...new Set([...stepModels.keys(), ...requestModels.keys()])]
    .map((key) => {
      const step = stepModels.get(key)
      const request = requestModels.get(key)
      const meta = step ?? request
      return {
        providerID: meta?.providerID ?? "",
        modelID: meta?.modelID ?? "",
        steps: finishSteps(step?.value),
        requests: finishRequests(request?.value),
      }
    })
    .sort(
      (a, b) =>
        sampleTotal(b) - sampleTotal(a) ||
        a.providerID.localeCompare(b.providerID) ||
        a.modelID.localeCompare(b.modelID),
    )

  const workspaces = [...new Set([...stepWorkspaces.keys(), ...requestWorkspaces.keys()])]
    .map((key) => ({
      workspaceID: key,
      steps: finishSteps(stepWorkspaces.get(key)),
      requests: finishRequests(requestWorkspaces.get(key)),
    }))
    .sort((a, b) => sampleTotal(b) - sampleTotal(a) || (a.workspaceID ?? "").localeCompare(b.workspaceID ?? ""))

  const daily = [...new Set([...stepDays.keys(), ...requestDays.keys()])]
    .sort()
    .map((day) => ({ day, steps: finishSteps(stepDays.get(day)), requests: finishRequests(requestDays.get(day)) }))

  // 保留策略来自 FR-05 的全局配置，writer.stats().limits 是当前生效值；不要退回硬编码。
  const retention = retentionStats().limits
  const nextSteps = stepFull ? scanBoundary(stepScan) : undefined
  const nextRequests = requestFull ? scanBoundary(requestScan) : undefined
  const next =
    nextSteps === undefined && nextRequests === undefined
      ? undefined
      : encodeSummary({
          projectID: scope.projectID,
          workspaceID: scope.workspaceID,
          from: filters.from,
          to: filters.to,
          providerID: filters.providerID,
          modelID: filters.modelID,
          sessionID: filters.sessionID,
          workspaceFilter: filters.workspaceID,
          ...(nextSteps === undefined ? {} : { steps: nextSteps }),
          ...(nextRequests === undefined ? {} : { requests: nextRequests }),
        })

  return {
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    steps: finishSteps(steps),
    requests: finishRequests(requests),
    ownership: {
      steps: { main: finishUsage(ownership.steps.main), sub: finishUsage(ownership.steps.sub) },
      requests: { main: finishUsage(ownership.requests.main), sub: finishUsage(ownership.requests.sub) },
    },
    models: models.slice(0, MAX_GROUPS),
    workspaces: workspaces.slice(0, MAX_GROUPS),
    daily: daily.slice(-MAX_TREND_DAYS),
    coverage: {
      steps: scanStepLedger ? coverageOf(stepScan.length, stepFull, stepRows) : { scanned: 0, truncated: false },
      requests: scanRequestLedger
        ? coverageOf(requestScan.length, requestFull, requestRows)
        : { scanned: 0, truncated: false },
    },
    truncated: stepFull || requestFull,
    ...(next === undefined ? {} : { next }),
    breakdownsTruncated: models.length > MAX_GROUPS || workspaces.length > MAX_GROUPS || daily.length > MAX_TREND_DAYS,
    limits: { scan: GLOBAL_SCAN_LIMIT, pageScan: PAGE_SCAN_LIMIT, groups: MAX_GROUPS, trendDays: MAX_TREND_DAYS },
    retention: {
      requestsPerSession: retention.requestsPerSession,
      totalRequests: retention.totalRequests,
      ...(retention.retentionMs === undefined ? {} : { retentionMs: retention.retentionMs }),
    },
  }
}
