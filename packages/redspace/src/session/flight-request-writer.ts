import { inArray, sql } from "drizzle-orm"
import * as Log from "@redcode-ai/core/util/log"
import { ConfigFlightRecorder } from "@/config/flight-recorder"
import { Database } from "@/storage/db"
import { CLEANUP_CHUNK, immediate, step, trimGlobalChunks, trimSession, type Sweep } from "./flight-request-retention"
import type { RequestData } from "./flight-recording"
import { FlightRequestTable } from "./flight-request.sql"
import type { SessionID } from "./schema"
import { MessageTable } from "./session.sql"

// 261126 Red 批量写入和退出行为见 docs/notes/implemented/feature/2026-11-26-flight-recorder.md#fr-03-写入与计时。
// FR-05 的容量上限归属全局配置（config/flight-recorder.ts）；这里只执行有界裁剪：
// 写批内每会话最多删 CLEANUP_CHUNK 行，剩余积压交给后台清理 tick 渐进收敛。
export const MAX_PENDING = 256
// 261126 Red 导出可写绑定：默认 128，配置初始化/configure 时更新为当前生效值；
// flight-recorder 的 retention 元数据通过 re-export 读到进程内实际限制，避免报告与裁剪不一致。
export let KEEP_PER_SESSION = ConfigFlightRecorder.DEFAULT_SESSION_ROWS
const BATCH_SIZE = 32
const RETRY_DELAY_MS = 20
const RETRY_WINDOW_MS = 250
// 后台清理的两个节奏：有积压时连续小步推进；只剩全局/期限上限时定期巡检，避免长期空闲不收敛。
const CLEANUP_STEP_MS = 25
const CLEANUP_WRITE_DELAY_MS = 250
const CLEANUP_IDLE_MS = 60_000
// 一个 tick 内最多执行 4 个会话/时间步；全局阶段在全部会话删除完成后只算一次边界。
const STEPS_PER_TICK = 4
const BOOT_RETRY_MS = 1_000
// 启动配置读取失败重试、成功后刷新（用户改配置无需重启）；失败时绝不按默认策略清理。
const CONFIG_RETRY_MS = 5_000
const CONFIG_REFRESH_MS = 60_000
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

// 261126 Red 清理状态。sweep 只在每会话上限调小时启动，从最小 session_id 向后逐会话推进；
// deferred 是写批预算用尽后仍需裁剪的活跃会话，优先于全量扫描处理。
let policy = ConfigFlightRecorder.resolve()
let sweep: Sweep | undefined
const deferred = new Set<SessionID>()
let cleanupTimer: ReturnType<typeof setTimeout> | undefined
let cleanupRuns = 0
let cleanupDeleted = 0
let cleanupFailures = 0
let lastCleanupMs = 0
let lastCleanupWarning = -Infinity
// 261126 Red 容量策略必须来自成功读取的全局配置。ready=false 时既不裁剪写入也不安排清理；
// 读取/校验失败保持 false（或保留上一次成功值），绝不退回默认上限删除旧库。
let ready = false
let manual = false
let configError: string | undefined
let configTimer: ReturnType<typeof setTimeout> | undefined
let lastConfigWarning = -Infinity

export function insert(row: Row): Client | undefined {
  if (!Database.Client.loaded()) {
    drop(1, "database-unavailable")
    return
  }
  const db = Database.Client()
  if (owner !== db) {
    discard("database-closed")
    resetCleanup()
    owner = db
  }
  if (enqueue(row.id, { row, data: row.data })) return db
}

export function update(db: Client, id: string, data: RequestData) {
  if (owner !== db || !Database.Client.loaded() || Database.Client() !== db) return drop(1, "database-closed")
  enqueue(id, { row: pending.get(id)?.row, data })
}

// 261126 Red 显式策略入口（测试/诊断）。生产启动由 boot 读取全局配置初始化，不依赖调用方；
// 一旦手动配置，启动读取的迟到结果不再覆盖它。
export function configure(input?: ConfigFlightRecorder.Input) {
  const next = ConfigFlightRecorder.resolve(input)
  manual = true
  clearTimeout(configTimer)
  configTimer = undefined
  configError = undefined
  applyPolicy(next)
  ready = true
  if (owner) scheduleCleanup(0)
}

function applyPolicy(next: ConfigFlightRecorder.Resolved) {
  const previous = policy
  const changed =
    next.maxRequestsPerSession !== previous.maxRequestsPerSession ||
    next.maxTotalRequests !== previous.maxTotalRequests ||
    next.retentionMs !== previous.retentionMs
  policy = next
  KEEP_PER_SESSION = next.maxRequestsPerSession
  // 调小每会话上限时从头扫全部会话；调大时不需要继续为旧的更小限制做扫描。
  // 首次成功读取不强制全表扫描：正常 V1 数据每会话已 ≤128，避免每次启动都走一遍所有会话。
  if (next.maxRequestsPerSession < previous.maxRequestsPerSession) sweep = {}
  else if (next.maxRequestsPerSession > previous.maxRequestsPerSession) sweep = undefined
  if (changed && owner) scheduleCleanup(0)
}

export function stats() {
  return {
    pending: pending.size,
    dropped,
    batches,
    lastWriteMs,
    limits: {
      requestsPerSession: policy.maxRequestsPerSession,
      totalRequests: policy.maxTotalRequests,
      retentionMs: policy.retentionMs,
    },
    cleanup: {
      runs: cleanupRuns,
      deleted: cleanupDeleted,
      failures: cleanupFailures,
      lastMs: lastCleanupMs,
      // 实际积压工作；默认全局上限总会配置，不能拿它当「有待处理」的信号。
      active: deferred.size > 0 || sweep !== undefined,
      scheduled: cleanupTimer !== undefined,
      ready,
      ...(configError === undefined ? {} : { configError }),
    },
  }
}

// 261126 Red 只测试/诊断调用：同步推进一个有界清理 tick，返回是否还有积压。
// 生产由 runCleanup 的定时链驱动，测试循环调用它即可确定性地收敛。
export function cleanup() {
  if (!ready || !owner || !Database.Client.loaded() || Database.Client() !== owner) return false
  return runStep().more
}

function enqueue(id: string, write: Write) {
  if (pending.size === MAX_PENDING && !pending.has(id)) {
    drop(1, "queue-full")
    return false
  }
  pending.set(id, write)
  schedule()
  if (write.row && ready && needsWork()) scheduleCleanup(0)
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
  if (closing) return discard("shutdown")
  if (pending.size > 0) schedule()
  if (!ready) return
  if (deferred.size > 0) scheduleCleanup(0)
  else if (policy.maxTotalRequests !== undefined || policy.retentionMs !== undefined)
    scheduleCleanup(CLEANUP_WRITE_DELAY_MS)
}

function writeBatch(db: Client, batch: [string, Write][]) {
  // 261126 Red 同一条同步回调内恢复连接的等待设置，普通会话写入仍用自己的 busy_timeout。
  immediate(db, (tx) => {
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
        // 261126 Red 配置尚未成功读取时只落行、不裁剪；ready 后的首个 tick 会补扫，
        // 避免用默认上限误删用户旧库。
        if (ready) {
          // 写批最多删一个 CLEANUP_CHUNK 的窗口超额行；没轮到的活跃会话转入 deferred，
          // 由后续 tick 继续，避免配置缩容后某一批一次删掉整段积压。
          let budget = CLEANUP_CHUNK
          for (const session of new Set(surviving.map((row) => row.session_id))) {
            if (budget <= 0) {
              deferred.add(session)
              continue
            }
            const allowed = budget
            const removed = trimSession(tx, session, policy.maxRequestsPerSession, allowed)
            budget -= removed
            // 261126 Red 删满这次预算时可能还有积压，转入 deferred 让后续 tick 继续确认；
            // 只多一次空转，不会把整段积压塞进同一个写批事务。
            if (removed === allowed) deferred.add(session)
          }
        }
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
  })
}

function needsWork() {
  if (!ready) return false
  return (
    deferred.size > 0 ||
    sweep !== undefined ||
    policy.maxTotalRequests !== undefined ||
    policy.retentionMs !== undefined
  )
}

function scheduleCleanup(delay: number) {
  if (!ready) return
  if (cleanupTimer !== undefined) {
    if (delay !== 0) return
    clearTimeout(cleanupTimer)
  }
  cleanupTimer = setTimeout(runCleanup, delay)
  cleanupTimer.unref()
}

function cancelCleanup() {
  clearTimeout(cleanupTimer)
  cleanupTimer = undefined
}

function resetCleanup() {
  cancelCleanup()
  sweep = undefined
  deferred.clear()
}

function runCleanup() {
  cleanupTimer = undefined
  if (!ready) return
  if (!owner || !Database.Client.loaded() || Database.Client() !== owner) return resetCleanup()
  try {
    const result = runStep()
    if (result.more) scheduleCleanup(CLEANUP_STEP_MS)
    // 261126 Red 全局行数只随写入增长，写完会重新安排；保留期限会随墙上时间继续过期。
    // 默认全局上限也需要低频巡检：别的进程写入或上次 tick 之后的新增都可能在本次进程没有
    // 新请求时把表推过上限。timer.unref 不阻止进程退出。
    else scheduleCleanup(CLEANUP_IDLE_MS)
  } catch (error) {
    cleanupFailures++
    if (isLocked(error)) return scheduleCleanup(CLEANUP_STEP_MS)
    const now = performance.now()
    if (now - lastCleanupWarning >= 60_000) {
      lastCleanupWarning = now
      log.warn("flight-request.cleanup-failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function runStep() {
  const db = owner!
  const start = performance.now()
  const deferredSession = deferred.values().next().value
  let keepDeferred = false
  const result = immediate(db, (tx) => {
    let more = false
    let deleted = 0
    let cursor = sweep

    if (deferredSession) {
      const count = trimSession(tx, deferredSession, policy.maxRequestsPerSession, CLEANUP_CHUNK)
      deleted += count
      if (count === CLEANUP_CHUNK) {
        keepDeferred = true
        more = true
      }
    }

    // 261126 Red 阶段 1：先完成所有会改变行集的 session/age 删除。全局边界必须在这之后计算，
    // 不能在会话删掉较新行后复用旧边界继续删最老行，否则会删到低于全局上限。
    for (let round = 0; round < STEPS_PER_TICK; round++) {
      const swept = step({ tx, policy, now: Date.now(), sweep: cursor, limit: CLEANUP_CHUNK })
      cursor = swept.sweep
      deleted += swept.deleted
      if (swept.more) more = true
      if (!swept.more) break
    }

    // 阶段 2：全局容量。边界只在所有 session/age 删除完成后计算一次；阶段内没有其他删除，
    // 同一边界可以安全地连续使用。
    const global = trimGlobalChunks(tx, policy.maxTotalRequests, STEPS_PER_TICK, CLEANUP_CHUNK)
    deleted += global.deleted
    if (global.more) more = true

    return { more: more || deferred.size > 0, deleted, sweep: cursor }
  })
  sweep = result.sweep
  if (deferredSession && !keepDeferred) deferred.delete(deferredSession)
  cleanupRuns++
  cleanupDeleted += result.deleted
  lastCleanupMs = performance.now() - start
  return result
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

// 261126 Red 启动即巡检：即使没有任何新请求，旧库也可能超过全局上限。但必须先成功读取
// 全局配置（不是默认值）再启用任何删除；数据库由应用启动时打开，这里只轮询 loaded 状态，
// 不主动打开库。
let bootTimer: ReturnType<typeof setTimeout> | undefined
let bootStarted = false
function boot() {
  if (bootStarted) return
  bootStarted = true
  watchDatabase()
}

async function initializePolicy(refresh: boolean) {
  const result = await ConfigFlightRecorder.loadGlobal(refresh)
  // 261126 Red 显式 configure（测试/诊断）优先；迟到的启动读取结果不得覆盖它。
  if (manual) return
  if (!result.ok) {
    configError = result.error
    const now = performance.now()
    if (now - lastConfigWarning >= 60_000) {
      lastConfigWarning = now
      log.warn("flight-request.config-unavailable", { error: result.error })
    }
    configTimer = setTimeout(() => void initializePolicy(true), CONFIG_RETRY_MS)
    configTimer.unref()
    return
  }
  configError = undefined
  applyPolicy(result.policy)
  ready = true
  if (Database.Client.loaded()) {
    owner ??= Database.Client()
    scheduleCleanup(0)
  }
  // 261126 Red 进程存活期间定期刷新；配置被改小/改大后不需要重启，读取失败则保留
  // 上一次成功策略并重试，绝不按默认值清理。
  configTimer = setTimeout(() => void initializePolicy(true), CONFIG_REFRESH_MS)
  configTimer.unref()
}

// 261127 Red 配置读取跟随数据库打开：本模块在 import 时启动 boot，早于 CLI 的 Log.init
// （--help 直接短路、plugin worker 不初始化日志），导入即读配置会把 service=config 的
// INFO 写进 stderr。没有打开的库就没有可清理的行。
function watchDatabase() {
  if (!Database.Client.loaded()) {
    bootTimer = setTimeout(watchDatabase, BOOT_RETRY_MS)
    bootTimer.unref()
    return
  }
  owner ??= Database.Client()
  if (ready) return scheduleCleanup(0)
  void initializePolicy(false)
}

process.nextTick(boot)
process.once("exit", () => flush(true))
