import { sql } from "drizzle-orm"
import type { Resolved } from "@/config/flight-recorder"
import { Database } from "@/storage/db"
import { FlightRequestTable } from "./flight-request.sql"
import type { SessionID } from "./schema"

// 261126 Red FR-05 的有界容量原语。所有删除都先按索引定位一个边界（LIMIT 1 OFFSET keep-1），
// 再按 (time_created,id) 顺序每次最多删 CLEANUP_CHUNK 行；不 COUNT、不整表扫描、不做大事务。
// 边界与删除在同一个 BEGIN IMMEDIATE 事务里，跨进程写锁串行化，避免并发删除越过保留线。
// 只操作 flight_request：账单步骤（part）、消息和会话永不由这里删除。
export const CLEANUP_CHUNK = 32

type Client = ReturnType<typeof Database.Client>
type Executor = Database.TxOrDb

export type Boundary = { readonly time: number; readonly id: string }

// 261126 Red 写入批同样以零等待拿写锁；BEGIN 本身失败时也要恢复 busy_timeout。
export function immediate<T>(db: Client, callback: (tx: Executor) => T): T {
  const previous = db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)!.timeout
  db.run("PRAGMA busy_timeout = 0")
  try {
    db.run("BEGIN IMMEDIATE")
    try {
      const result = callback(db)
      db.run("COMMIT")
      return result
    } catch (error) {
      try {
        db.run("ROLLBACK")
      } catch {
        // 261126 Red SQLite 可能已因错误结束事务；保留原始错误才是诊断所需的。
      }
      throw error
    }
  } finally {
    db.run(`PRAGMA busy_timeout = ${previous}`)
  }
}

function sessionBoundary(tx: Executor, sessionID: SessionID, keep: number): Boundary | undefined {
  return tx.get<Boundary>(sql`
    SELECT time_created AS time, id FROM ${FlightRequestTable}
    WHERE session_id = ${sessionID}
    ORDER BY time_created DESC, id DESC
    LIMIT 1 OFFSET ${keep - 1}
  `) as Boundary | undefined
}

export function globalBoundary(tx: Executor, keep: number): Boundary | undefined {
  return tx.get<Boundary>(sql`
    SELECT time_created AS time, id FROM ${FlightRequestTable}
    ORDER BY time_created DESC, id DESC
    LIMIT 1 OFFSET ${keep - 1}
  `) as Boundary | undefined
}

// 返回删除行数。只删严格早于边界的行，因此并发插入/删除最多让本次少删，不会越过保留线。
export function trimSession(tx: Executor, sessionID: SessionID, keep: number, limit = CLEANUP_CHUNK): number {
  const boundary = sessionBoundary(tx, sessionID, keep)
  if (!boundary) return 0
  return tx.all<{ id: string }>(sql`
    DELETE FROM ${FlightRequestTable}
    WHERE id IN (
      SELECT id FROM ${FlightRequestTable}
      WHERE session_id = ${sessionID} AND (time_created, id) < (${boundary.time}, ${boundary.id})
      ORDER BY time_created ASC, id ASC
      LIMIT ${limit}
    )
    RETURNING id
  `).length
}

export function trimByAge(tx: Executor, now: number, retentionMs: number, limit = CLEANUP_CHUNK): number {
  return tx.all<{ id: string }>(sql`
    DELETE FROM ${FlightRequestTable}
    WHERE id IN (
      SELECT id FROM ${FlightRequestTable}
      WHERE time_created < ${now - retentionMs}
      ORDER BY time_created ASC, id ASC
      LIMIT ${limit}
    )
    RETURNING id
  `).length
}

export function trimGlobalFrom(tx: Executor, boundary: Boundary, limit = CLEANUP_CHUNK): number {
  // 261126 Red 不能用 changes()：flight_request 上有 AFTER DELETE 触发器同步 flight_scope，
  // 驱动返回的 changes 会把触发器影响也算进来，统计会虚高（实测 32 行报 64）。RETURNING
  // 只计算真正删掉的 flight_request 行，且数量有 LIMIT 上界。
  return tx.all<{ id: string }>(sql`
    DELETE FROM ${FlightRequestTable}
    WHERE id IN (
      SELECT id FROM ${FlightRequestTable}
      WHERE (time_created, id) < (${boundary.time}, ${boundary.id})
      ORDER BY time_created ASC, id ASC
      LIMIT ${limit}
    )
    RETURNING id
  `).length
}

export function trimGlobal(tx: Executor, keep: number, limit = CLEANUP_CHUNK): number {
  const boundary = globalBoundary(tx, keep)
  return boundary ? trimGlobalFrom(tx, boundary, limit) : 0
}

// 261126 Red 全局阶段只做全局删除：边界在会话/时间删除全部完成后才计算，阶段内不再有
// session/age 删除，因此同一个边界可以安全地连续删多批。调用方不得在批次之间插入其他删除。
export function trimGlobalChunks(
  tx: Executor,
  keep: number,
  rounds = 1,
  limit = CLEANUP_CHUNK,
): { deleted: number; more: boolean } {
  const boundary = globalBoundary(tx, keep)
  if (!boundary) return { deleted: 0, more: false }
  let deleted = 0
  for (let round = 0; round < rounds; round++) {
    const count = trimGlobalFrom(tx, boundary, limit)
    deleted += count
    if (count < limit) return { deleted, more: false }
  }
  return { deleted, more: true }
}

export function nextSession(tx: Executor, after?: SessionID): SessionID | undefined {
  const row = tx.get<{ session_id: SessionID }>(sql`
    SELECT session_id FROM ${FlightRequestTable}
    ${after === undefined ? sql`` : sql`WHERE session_id > ${after}`}
    ORDER BY session_id ASC
    LIMIT 1
  `) as { session_id: SessionID } | undefined
  return row?.session_id
}

export type Sweep = { readonly cursor?: SessionID }

export type Step = {
  readonly sweep: Sweep | undefined
  readonly deleted: number
  readonly more: boolean
}

// 一个会话/时间清理步：至多处理一个扫描会话、一批过期行。全局容量由 phase 2 之后的
// trimGlobalChunks 独占执行，避免会话删除后复用陈旧全局边界。
export function step(input: { tx: Executor; policy: Resolved; now: number; sweep?: Sweep; limit?: number }): Step {
  const limit = input.limit ?? CLEANUP_CHUNK
  let sweep = input.sweep
  let deleted = 0
  let more = false

  if (sweep) {
    const session = nextSession(input.tx, sweep.cursor)
    if (session === undefined) {
      sweep = undefined
    } else {
      const count = trimSession(input.tx, session, input.policy.maxRequestsPerSession, limit)
      deleted += count
      if (count < limit) sweep = { cursor: session }
      more = true
    }
  }

  if (input.policy.retentionMs !== undefined) {
    const count = trimByAge(input.tx, input.now, input.policy.retentionMs, limit)
    deleted += count
    if (count === limit) more = true
  }

  return { sweep, deleted, more }
}
