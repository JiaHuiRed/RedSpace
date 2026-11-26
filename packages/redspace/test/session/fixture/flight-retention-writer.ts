import assert from "node:assert/strict"
import { Database as SQLite } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { ConfigFlightRecorder } from "@/config/flight-recorder"
import { Database } from "@/storage/db"
import { FlightRequestTable } from "@/session/flight-request.sql"
import { CLEANUP_CHUNK } from "@/session/flight-request-retention"
import { MessageID, SessionID } from "@/session/schema"

// 261126 Red FR-05 写入端容量策略的隔离 DB 夹具。由 test/session/flight-retention.test.ts
// 以独立 REDCODE_DB 子进程运行，不会碰到主测试进程或用户真实数据库。
//   legacy：先写入 782 个会话 × 128 行（100,096 行，超过默认全局 100,000），再导入 writer，
//           不产生任何新请求，验证启动巡检把旧库有界收敛到上限，且 part/message/session 不受影响。
//   policy：验证配置缩容、全局上限、保留期限、迟到结算不复活、写锁重试与统计。
const mode = process.argv[2]
const raw = Database.Client().$client
const results: Record<string, unknown> = {}
const pad = (value: number) => String(value).padStart(4, "0")
const pad2 = (value: number) => String(value).padStart(3, "0")

type WriterModule = typeof import("@/session/flight-request-writer")
let writer: WriterModule

function seed(session: SessionID, message: MessageID) {
  raw.run("INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, ?, ?, ?)", [
    "prj_retention",
    "/retention",
    "[]",
    0,
    0,
  ])
  raw.run(
    "INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [session, "prj_retention", session, "/retention", "Retention", "test", 0, 0],
  )
  raw.run("INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)", [
    message,
    session,
    0,
    0,
    '{"role":"assistant"}',
  ])
}

type Input = { readonly id: string; readonly session: SessionID; readonly message: MessageID; readonly time: number }

function write(rows: Input[]) {
  for (const row of rows) {
    writer.insert({
      id: row.id,
      session_id: row.session,
      message_id: row.message,
      time_created: row.time,
      provider_id: "provider",
      model_id: "model",
      data: { outcome: "unknown" },
    })
  }
  flush()
}

function flush() {
  for (let round = 0; round < 64 && writer.stats().pending > 0; round++) writer.flush()
  assert.equal(writer.stats().pending, 0, "pending writes must flush")
}

function count(session?: SessionID) {
  const value =
    session === undefined
      ? raw.query("SELECT count(*) AS n FROM flight_request").get()
      : raw.query("SELECT count(*) AS n FROM flight_request WHERE session_id = ?").get(session)
  return (value as { n: number }).n
}

function scalar(table: string) {
  return (raw.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

function newest(session: SessionID, limit: number) {
  return raw
    .query("SELECT id FROM flight_request WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?")
    .all(session, limit) as { id: string }[]
}

async function waitFor(condition: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function seedLegacy() {
  const sessions = 782
  const perSession = 128
  const rows = sessions * perSession
  const insertSession = raw.prepare(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_retention', ?, '/retention', 'Legacy', 'test', 0, 0)",
  )
  const insertMessage = raw.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 0, 0, '{\"role\":\"assistant\"}')",
  )
  const insertRow = raw.prepare(
    "INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES (?, ?, ?, ?, 'provider', 'model', '{\"outcome\":\"unknown\"}')",
  )
  seed(SessionID.make(`ses_legacy_${pad2(0)}`), MessageID.make(`msg_legacy_${pad2(0)}`))
  raw.run("BEGIN")
  for (let session = 1; session < sessions; session++) {
    const id = `ses_legacy_${pad2(session)}`
    insertSession.run(id, id)
    insertMessage.run(`msg_legacy_${pad2(session)}`, id)
  }
  for (let session = 0; session < sessions; session++) {
    const sessionID = SessionID.make(`ses_legacy_${pad2(session)}`)
    const messageID = MessageID.make(`msg_legacy_${pad2(session)}`)
    for (let index = 0; index < perSession; index++) {
      insertRow.run(`leg_${pad2(session)}_${pad(index)}`, sessionID, messageID, session * perSession + index)
    }
  }
  // 账单步骤和消息必须幸存：给最早被淘汰的会话留一条 step-finish。
  raw.run(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part_legacy', ?, ?, 0, 0, ?)",
    ["msg_legacy_000", "ses_legacy_000", '{"type":"step-finish","tokens":{"context":10,"output":1}}'],
  )
  raw.run("COMMIT")

  return { rows, messages: scalar("message"), parts: scalar("part"), sessions: scalar("session") }
}

async function legacy() {
  const before = seedLegacy()
  assert.equal(count(), before.rows)
  writer = await import("@/session/flight-request-writer")
  // 261126 Red 导入前已种好超额旧库；不调用 configure、不产生新请求。启动必须先成功
  // 读取全局配置（这里为空配置 → 默认 100,000）再清理。
  await waitFor(() => writer.stats().cleanup.ready, "config load")
  await waitFor(() => count() === 100_000, "legacy global cap")
  assert.equal(count(), 100_000)
  assert.equal(scalar("part"), before.parts)
  assert.equal(scalar("message"), before.messages)
  assert.equal(scalar("session"), before.sessions)
  assert.equal(
    (raw.query("SELECT id FROM flight_request WHERE id = 'leg_000_0000'").get() as { id: string } | null),
    null,
  )
  assert.ok((raw.query("SELECT id FROM flight_request WHERE id = 'leg_000_0096'").get() as { id: string } | null))
  results.legacy = {
    before: before.rows,
    after: count(),
    parts: scalar("part"),
    messages: scalar("message"),
    sessions: scalar("session"),
    stats: writer.stats(),
  }
}

// 261126 Red 失败模式 1：全局配置写的是 200,000，旧库 100,096 条。启动巡检必须读到真实
// 配置后才允许清理；在此之前按默认 100,000 会误删 96 条。
async function configOk() {
  const before = seedLegacy()
  writer = await import("@/session/flight-request-writer")
  await waitFor(() => writer.stats().cleanup.ready, "config load", 15_000)
  assert.equal(writer.stats().limits.totalRequests, 200_000)
  // 给启动 tick 足够时间运行；配置上限 200,000 > 100,096，任何删除都是错误。
  await Bun.sleep(500)
  assert.equal(count(), before.rows)
  assert.equal(writer.stats().cleanup.deleted, 0)
  results.configOk = { before, after: count(), limits: writer.stats().limits, stats: writer.stats() }
}

// 261126 Red 失败模式 1：配置读取/校验失败时不得退回默认上限清理，即使等待重试也不能删。
async function configInvalid() {
  const before = seedLegacy()
  writer = await import("@/session/flight-request-writer")
  await waitFor(() => writer.stats().cleanup.configError !== undefined, "config error", 15_000)
  assert.equal(writer.stats().cleanup.ready, false)
  const runs = writer.stats().cleanup.runs
  // 覆盖一次启动重试（CONFIG_RETRY_MS=5s）：坏配置仍不能按默认值清理。
  await Bun.sleep(5_500)
  assert.equal(count(), before.rows)
  assert.equal(writer.stats().cleanup.runs, runs)
  results.configInvalid = {
    after: count(),
    ready: writer.stats().cleanup.ready,
    configError: writer.stats().cleanup.configError,
    runs: writer.stats().cleanup.runs,
  }
}

async function policy() {
  writer = await import("@/session/flight-request-writer")

  // 默认值：每会话 128、全局 100,000；全局上限默认生效。
  writer.configure(undefined)
  assert.equal(writer.KEEP_PER_SESSION, 128)
  assert.deepEqual(writer.stats().limits, {
    requestsPerSession: 128,
    totalRequests: 100_000,
    retentionMs: undefined,
  })
  assert.equal(writer.stats().cleanup.active, false)
  assert.deepEqual(ConfigFlightRecorder.resolve(), { maxRequestsPerSession: 128, maxTotalRequests: 100_000 })
  results.defaults = { keep: writer.KEEP_PER_SESSION, limits: writer.stats().limits }

  // 1) 每会话上限缩容：写批只做有界裁剪，剩余由后台 tick 渐进收敛。
  const shrink = SessionID.make("ses_retention_shrink")
  const shrinkMessage = MessageID.make("msg_retention_shrink")
  seed(shrink, shrinkMessage)
  const base = Date.now() - 50_000
  write(
    Array.from({ length: 80 }, (_, index) => ({
      id: `shr_${pad(index)}`,
      session: shrink,
      message: shrinkMessage,
      time: base + index,
    })),
  )
  assert.equal(count(shrink), 80)
  const deletedBeforeShrink = writer.stats().cleanup.deleted
  writer.configure({ max_requests_per_session: 10 })
  writer.cleanup()
  const shrinkDeleted = writer.stats().cleanup.deleted - deletedBeforeShrink
  assert.ok(shrinkDeleted > 0 && shrinkDeleted <= CLEANUP_CHUNK * 4, "one tick deletes bounded chunks")
  assert.equal(count(shrink), 80 - shrinkDeleted)
  await waitFor(() => count(shrink) === 10, "per-session shrink")
  assert.deepEqual(
    newest(shrink, 10).map((row) => row.id),
    Array.from({ length: 10 }, (_, index) => `shr_${pad(79 - index)}`),
  )
  results.shrink = { rows: count(shrink) }

  // 2) 已裁剪的请求在迟到结算后不能复活；UPDATE 只影响仍在的行。
  writer.update(Database.Client(), "shr_0000", { outcome: "failed" })
  flush()
  assert.equal(count(shrink), 10)
  assert.ok(!newest(shrink, 10).some((row) => row.id === "shr_0000"))
  results.lateSettlement = { rows: count(shrink) }

  // 3) 全局行数：显式调到 20 后保留全局最新 20 条，单 tick 删除有界。
  writer.configure(undefined)
  await waitFor(() => !writer.stats().cleanup.active, "cleanup reset")
  const globalA = SessionID.make("ses_retention_global_a")
  const globalB = SessionID.make("ses_retention_global_b")
  const globalMessageA = MessageID.make("msg_retention_global_a")
  const globalMessageB = MessageID.make("msg_retention_global_b")
  seed(globalA, globalMessageA)
  seed(globalB, globalMessageB)
  const current = Date.now()
  write([
    ...Array.from({ length: 60 }, (_, index) => ({
      id: `glo_a${pad(index)}`,
      session: globalA,
      message: globalMessageA,
      time: current + index,
    })),
    ...Array.from({ length: 60 }, (_, index) => ({
      id: `glo_b${pad(index)}`,
      session: globalB,
      message: globalMessageB,
      time: current + 1000 + index,
    })),
  ])
  const deletedBeforeGlobal = writer.stats().cleanup.deleted
  writer.configure({ max_total_requests: 20 })
  writer.cleanup()
  assert.ok(writer.stats().cleanup.deleted - deletedBeforeGlobal <= CLEANUP_CHUNK * 4, "global tick is bounded")
  await waitFor(() => count() === 20, "global cap")
  const kept = raw.query("SELECT id FROM flight_request ORDER BY time_created DESC, id DESC").all() as { id: string }[]
  assert.deepEqual(
    kept.map((row) => row.id),
    Array.from({ length: 20 }, (_, index) => `glo_b${pad(59 - index)}`),
  )
  results.global = { rows: count() }

  // 4) 保留期限：显式配置后按时间索引分批清理，空闲定时器也会收敛。
  writer.configure(undefined)
  await waitFor(() => !writer.stats().cleanup.active, "cleanup reset")
  const old = SessionID.make("ses_retention_old")
  const oldMessage = MessageID.make("msg_retention_old")
  seed(old, oldMessage)
  const now = Date.now()
  write([
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `old_${pad(index)}`,
      session: old,
      message: oldMessage,
      time: now - 10 * 24 * 60 * 60 * 1000 + index,
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `new_${pad(index)}`,
      session: old,
      message: oldMessage,
      time: now + index,
    })),
  ])
  const deletedBeforeAge = writer.stats().cleanup.deleted
  writer.configure({ retention_ms: 24 * 60 * 60 * 1000 })
  writer.cleanup()
  const ageDeleted = writer.stats().cleanup.deleted - deletedBeforeAge
  assert.ok(ageDeleted > 0 && ageDeleted <= CLEANUP_CHUNK * 4, "age tick deletes bounded chunks")
  await waitFor(() => count(old) === 8, "age retention")
  assert.equal(newest(old, 8)[0]?.id, "new_0007")
  results.retention = { rows: count(old) }

  // 5) 另一条连接持写锁时，清理 tick 只重试、不删除；释放后收敛。
  const lock = SessionID.make("ses_retention_lock")
  const lockMessage = MessageID.make("msg_retention_lock")
  seed(lock, lockMessage)
  write(
    Array.from({ length: 10 }, (_, index) => ({
      id: `lock_${pad(index)}`,
      session: lock,
      message: lockMessage,
      time: Date.now() + index,
    })),
  )
  const other = new SQLite(process.env["REDCODE_DB"]!)
  other.run("PRAGMA busy_timeout = 0")
  other.run("BEGIN IMMEDIATE")
  writer.configure({ max_requests_per_session: 5 })
  const locked = count(lock)
  await Bun.sleep(150)
  assert.equal(count(lock), locked, "locked cleanup must not delete")
  other.run("COMMIT")
  other.close()
  await waitFor(() => count(lock) === 5, "per-session after lock release")
  assert.equal((Database.Client().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)!).timeout, 5000)
  results.lock = { rows: count(lock) }

  const stats = writer.stats()
  assert.ok(stats.cleanup.runs > 0)
  assert.ok(stats.cleanup.deleted > 0)
  assert.equal(stats.dropped, 0)
  assert.ok(stats.cleanup.failures > 0, "the locked tick must be counted as a failure")
  results.stats = stats
}

// 261126 Red 失败模式 2：同 tick 里会话删除会改变全局边界。构造 C(1) + A(40 条同毫秒) +
// B(110)，上限 100、每会话 3。正确顺序是先做完全部 session 删除再算全局边界：
// A 删 37、B 删 32 后总数 82，已低于全局上限，不能再删 B[32..50]。
async function stale() {
  const c = SessionID.make("ses_stale_0")
  const a = SessionID.make("ses_stale_1")
  const b = SessionID.make("ses_stale_2")
  const cm = MessageID.make("msg_stale_0")
  const am = MessageID.make("msg_stale_1")
  const bm = MessageID.make("msg_stale_2")
  seed(c, cm)
  seed(a, am)
  seed(b, bm)
  const insert = raw.prepare(
    "INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES (?, ?, ?, ?, 'provider', 'model', '{\"outcome\":\"unknown\"}')",
  )
  raw.run("BEGIN")
  insert.run("c_0000", c, cm, 1000)
  for (let index = 0; index < 40; index++) insert.run(`a_${pad(index)}`, a, am, 1000)
  for (let index = 0; index < 110; index++) insert.run(`b_${pad(index)}`, b, bm, index)
  raw.run("COMMIT")
  assert.equal(count(), 151)

  writer = await import("@/session/flight-request-writer")
  await Bun.sleep(0)
  writer.configure({ max_requests_per_session: 3, max_total_requests: 100 })
  writer.cleanup()

  assert.equal(count(), 82)
  assert.equal(count(a), 3)
  assert.equal(count(b), 78)
  assert.equal(writer.stats().cleanup.deleted, 69)
  assert.equal((raw.query("SELECT id FROM flight_request WHERE id = 'b_0031'").get() as { id: string } | null), null)
  assert.ok((raw.query("SELECT id FROM flight_request WHERE id = 'b_0032'").get() as { id: string } | null))
  assert.ok((raw.query("SELECT id FROM flight_request WHERE id = 'b_0050'").get() as { id: string } | null))

  // 261126 Red 跨连接 + 等毫秒：另一条连接提交 20 条同毫秒行；下一个 tick 必须重算边界，
  // 只删当前最老的 2 条（B[32]/B[33]），不能沿用上一次的边界。
  const d = SessionID.make("ses_stale_3")
  const dm = MessageID.make("msg_stale_3")
  seed(d, dm)
  const other = new SQLite(process.env["REDCODE_DB"]!)
  other.run("PRAGMA busy_timeout = 0")
  other.run("BEGIN IMMEDIATE")
  const otherInsert = other.prepare(
    "INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES (?, ?, ?, 1000, 'provider', 'model', '{\"outcome\":\"unknown\"}')",
  )
  for (let index = 0; index < 20; index++) otherInsert.run(`d_${pad(index)}`, d, dm)
  other.run("COMMIT")
  other.close()
  assert.equal(count(), 102)

  writer.configure({ max_requests_per_session: 1000, max_total_requests: 100 })
  writer.cleanup()
  assert.equal(count(), 100)
  assert.equal((raw.query("SELECT id FROM flight_request WHERE id = 'b_0032'").get() as { id: string } | null), null)
  assert.equal((raw.query("SELECT id FROM flight_request WHERE id = 'b_0033'").get() as { id: string } | null), null)
  assert.ok((raw.query("SELECT id FROM flight_request WHERE id = 'b_0034'").get() as { id: string } | null))
  results.stale = { sameTick: 82, crossConnection: count(), stats: writer.stats() }
}

await (mode === "legacy"
  ? legacy()
  : mode === "config-ok"
    ? configOk()
    : mode === "config-invalid"
      ? configInvalid()
      : mode === "stale"
        ? stale()
        : policy())
console.log(`RESULT ${JSON.stringify({ ok: true, mode, ...results })}`)
Database.close()
