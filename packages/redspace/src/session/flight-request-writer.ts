import { inArray, sql } from "drizzle-orm"
import * as Log from "@redcode-ai/core/util/log"
import { Database } from "@/storage/db"
import type { RequestData } from "./flight-recording"
import { FlightRequestTable } from "./flight-request.sql"
import { MessageTable } from "./session.sql"

// 261126 Red 批量写入和退出行为见 docs/notes/implemented/feature/2026-11-26-flight-recorder.md#fr-03-写入与计时。
export const KEEP_PER_SESSION = 128
export const MAX_PENDING = 256
const BATCH_SIZE = 32
const RETRY_DELAY_MS = 20
const RETRY_WINDOW_MS = 250
const log = Log.create({ service: "flight-request-writer" })

type Client = ReturnType<typeof Database.Client>
type Row = typeof FlightRequestTable.$inferInsert
type Write = { readonly row?: Row; readonly data: RequestData }
const pending = new Map<string, Write>()
let owner: Client | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let retryUntil: number | undefined
let dropped = 0
let batches = 0
let lastWriteMs = 0
let lastWarning = -Infinity

export function insert(row: Row): Client | undefined {
  if (!Database.Client.loaded()) {
    drop(1, "database-unavailable")
    return
  }
  const db = Database.Client()
  if (owner !== db) {
    discard("database-closed")
    owner = db
  }
  if (enqueue(row.id, { row, data: row.data })) return db
}

export function update(db: Client, id: string, data: RequestData) {
  if (owner !== db || !Database.Client.loaded() || Database.Client() !== db) return drop(1, "database-closed")
  enqueue(id, { row: pending.get(id)?.row, data })
}

export function stats() {
  return { pending: pending.size, dropped, batches, lastWriteMs }
}

function enqueue(id: string, write: Write) {
  if (pending.size === MAX_PENDING && !pending.has(id)) {
    drop(1, "queue-full")
    return false
  }
  pending.set(id, write)
  schedule()
  return true
}

function schedule(delay = 0) {
  if (timer || pending.size === 0) return
  timer = setTimeout(flush, delay)
  timer.unref()
}

export function flush(closing = false) {
  clearTimeout(timer)
  timer = undefined
  if (pending.size === 0) return
  if (!owner || !Database.Client.loaded() || Database.Client() !== owner) return discard("database-closed")
  const batch = Array.from(pending.entries()).slice(0, BATCH_SIZE)
  const start = performance.now()
  try {
    writeBatch(owner, batch)
  } catch (error) {
    // 261126 Red 写锁走定时重试，其他 SQLite 写入失败丢当前批，避免阻断模型流。
    const locked = isLocked(error)
    if (locked && !closing) {
      retryUntil ??= performance.now() + RETRY_WINDOW_MS
      if (performance.now() < retryUntil) return schedule(RETRY_DELAY_MS)
      return discard("writer-locked")
    }
    drop(batch.length, locked ? "writer-locked" : "write-failed")
  } finally {
    batches++
    lastWriteMs = performance.now() - start
  }
  retryUntil = undefined
  for (const [id] of batch) pending.delete(id)
  if (closing) discard("shutdown")
  else schedule()
}

function writeBatch(db: Client, batch: [string, Write][]) {
  // 261126 Red 同一条同步回调内恢复连接的等待设置，普通会话写入仍用自己的 busy_timeout。
  const previous = db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)!.timeout
  db.run("PRAGMA busy_timeout = 0")
  try {
    db.transaction(
      (tx) => {
        const insertions = batch.flatMap(([, write]) => (write.row ? [{ ...write.row, data: write.data }] : []))
        if (insertions.length > 0) {
          const parents = tx
            .select({ id: MessageTable.id, session: MessageTable.session_id })
            .from(MessageTable)
            .where(
              inArray(
                MessageTable.id,
                insertions.map((row) => row.message_id),
              ),
            )
            .all()
          const sessions = new Map(parents.map((parent) => [parent.id, parent.session]))
          const surviving = insertions.filter((row) => sessions.get(row.message_id) === row.session_id)
          if (surviving.length > 0) {
            tx.insert(FlightRequestTable).values(surviving).onConflictDoNothing().run()
            const affected = [...new Set(surviving.map((row) => row.session_id))]
            tx.run(sql`
              DELETE FROM ${FlightRequestTable} WHERE id IN (
                SELECT id FROM (
                  SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY time_created DESC, id DESC) AS position
                  FROM ${FlightRequestTable} WHERE ${inArray(FlightRequestTable.session_id, affected)}
                ) WHERE position > ${KEEP_PER_SESSION}
              )
            `)
          }
        }
        const updates = batch.flatMap(([id, write]) => (write.row ? [] : [{ id, data: write.data }]))
        if (updates.length > 0) {
          tx.run(sql`
            UPDATE ${FlightRequestTable} SET data = revision.data
            FROM (
              SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.data') AS data
              FROM json_each(${JSON.stringify(updates)})
            ) AS revision
            WHERE ${FlightRequestTable.id} = revision.id
          `)
        }
      },
      { behavior: "immediate" },
    )
  } finally {
    db.run(`PRAGMA busy_timeout = ${previous}`)
  }
}

function isLocked(error: unknown) {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
  if (typeof cause !== "object" || cause === null) return false
  if ("code" in cause && (cause.code === "SQLITE_BUSY" || cause.code === "SQLITE_LOCKED")) return true
  return "errcode" in cause && typeof cause.errcode === "number" && [5, 6].includes(cause.errcode & 255)
}

function discard(reason: string) {
  if (pending.size > 0) drop(pending.size, reason)
  pending.clear()
  retryUntil = undefined
}

function drop(count: number, reason: string) {
  dropped += count
  const now = performance.now()
  if (now - lastWarning < 60_000) return
  lastWarning = now
  log.warn("flight-request.write-dropped", { reason, count, total: dropped })
}

process.once("exit", () => flush(true))
