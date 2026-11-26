import { and, desc, eq, sql } from "drizzle-orm"
import { Option, Schema } from "effect"
import { Database } from "@/storage/db"
import { FlightRequestTable } from "./flight-request.sql"
import { Diagnostics, PrefixChange } from "./flight-recording"
import type { SessionID } from "./schema"
import { MessageTable, PartTable } from "./session.sql"

// 261126 Red 账单步骤和实际请求分开分页，不能加总。见 docs/notes/implemented/feature/2026-11-26-flight-recorder.md
export const Source = Schema.Literals(["steps", "requests"])
export type Source = typeof Source.Type
export const MAX_PAGE = 50
const metric = Schema.optional(Schema.Finite)
export const Row = Schema.Struct({
  id: Schema.String,
  messageID: Schema.String,
  time: Schema.Finite,
  providerID: Schema.String,
  modelID: Schema.String,
  outcome: Schema.Literals(["booked", "estimated", "completed", "failed", "cancelled", "unknown"]),
  summary: Schema.optional(Schema.Boolean),
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

export function page(sessionID: SessionID, source: Source, limit = 20, before?: string): Page | undefined {
  const cursor = before === undefined ? undefined : Option.getOrUndefined(decode(before))
  if (before !== undefined && (!cursor || cursor.sessionID !== sessionID || cursor.source !== source)) return
  const rows = source === "steps" ? steps(sessionID, limit + 1, cursor) : requests(sessionID, limit + 1, cursor)
  if (rows.length <= limit) return { items: rows }
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return { items, next: encode({ sessionID, source, time: last.time, id: last.id }) }
}

const visible = sql`ifnull(json_extract(${MessageTable.data}, '$.detached'), 0) = 0`
const summary = sql<number | null>`json_extract(${MessageTable.data}, '$.summary')`

function steps(sessionID: SessionID, limit: number, cursor?: Cursor): Row[] {
  const p = PartTable
  const rows = Database.use((db) =>
    db
      .select({
        id: p.id,
        messageID: p.message_id,
        time: p.time_created,
        summary,
        providerID: sql<string>`coalesce(substr(json_extract(${MessageTable.data}, '$.providerID'), 1, 256), '')`,
        modelID: sql<string>`coalesce(substr(json_extract(${MessageTable.data}, '$.modelID'), 1, 256), '')`,
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
      .where(
        and(
          eq(p.session_id, sessionID),
          eq(MessageTable.session_id, sessionID),
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

function requests(sessionID: SessionID, limit: number, cursor?: Cursor): Row[] {
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
        summary,
      })
      .from(r)
      .innerJoin(MessageTable, eq(r.message_id, MessageTable.id))
      .where(
        and(
          eq(r.session_id, sessionID),
          eq(MessageTable.session_id, sessionID),
          visible,
          cursor && sql`(${r.time_created}, ${r.id}) < (${cursor.time}, ${cursor.id})`,
        ),
      )
      .orderBy(desc(r.time_created), desc(r.id))
      .limit(limit)
      .all(),
  ).map(({ data, summary, ...row }) => ({ ...row, ...data, summary: summary ? true : undefined }))
}
