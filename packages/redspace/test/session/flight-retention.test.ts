import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ConfigFlightRecorder } from "@/config/flight-recorder"
import {
  CLEANUP_CHUNK,
  immediate,
  trimByAge,
  trimGlobal,
  trimSession,
} from "@/session/flight-request-retention"
import { SessionID } from "@/session/schema"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

const sessionA = SessionID.make("ses_retention_a")
const sessionB = SessionID.make("ses_retention_b")
const sessionC = SessionID.make("ses_retention_c")

const schema = `
  CREATE TABLE flight_request (
    id text PRIMARY KEY NOT NULL,
    session_id text NOT NULL,
    message_id text NOT NULL,
    time_created integer NOT NULL,
    provider_id text NOT NULL,
    model_id text NOT NULL,
    data text NOT NULL
  );
  CREATE INDEX flight_request_session_time_created_id_idx
    ON flight_request (session_id, time_created, id);
  CREATE INDEX flight_request_time_created_id_idx
    ON flight_request (time_created, id);
`

async function fileDatabase(dir: string) {
  const file = path.join(dir, "flight.db")
  const client = new SQLite(file, { create: true })
  client.exec(schema)
  return { file, client, db: drizzle({ client }) }
}

function multiset(file: string, rows: { session: SessionID; count: number; start: number; prefix: string }[]) {
  const db = new SQLite(file)
  db.run("PRAGMA busy_timeout = 5000")
  const insert = db.prepare(
    "INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  db.transaction(() => {
    for (const group of rows) {
      for (let index = 0; index < group.count; index++) {
        insert.run(
          `${group.prefix}_${String(index).padStart(4, "0")}`,
          group.session,
          "msg_retention",
          group.start + index,
          "provider",
          "model",
          JSON.stringify({ outcome: "completed" }),
        )
      }
    }
  })()
  db.close()
}

function rows(file: string, session?: SessionID) {
  const db = new SQLite(file, { readonly: true })
  const result = (
    session === undefined
      ? db.query("SELECT id FROM flight_request ORDER BY time_created DESC, id DESC").all()
      : db.query("SELECT id FROM flight_request WHERE session_id = ? ORDER BY time_created DESC, id DESC").all(session)
  ) as { id: string }[]
  db.close()
  return result
}

function count(file: string, session?: SessionID) {
  const db = new SQLite(file, { readonly: true })
  const value = (
    session === undefined
      ? db.query("SELECT count(*) AS n FROM flight_request").get()
      : db.query("SELECT count(*) AS n FROM flight_request WHERE session_id = ?").get(session)
  ) as { n: number }
  db.close()
  return value.n
}

test("capacity limits reject unsafe or oversized integers and keep the 128 / 100000 defaults", () => {
  expect(ConfigFlightRecorder.resolve()).toEqual({ maxRequestsPerSession: 128, maxTotalRequests: 100_000 })
  expect(
    ConfigFlightRecorder.resolve({ max_requests_per_session: 16, max_total_requests: 1000, retention_ms: 86_400_000 }),
  ).toEqual({ maxRequestsPerSession: 16, maxTotalRequests: 1000, retentionMs: 86_400_000 })
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => ConfigFlightRecorder.resolve({ max_requests_per_session: value })).toThrow()
    expect(() => ConfigFlightRecorder.resolve({ max_total_requests: value })).toThrow()
    expect(() => ConfigFlightRecorder.resolve({ retention_ms: value })).toThrow()
  }
  // 261126 Red 硬上限不是「任意正整数」：边界查询是 OFFSET 索引扫描，必须限制在实测规模内。
  expect(ConfigFlightRecorder.resolve({ max_total_requests: ConfigFlightRecorder.MAX_ROWS }).maxTotalRequests).toBe(
    ConfigFlightRecorder.MAX_ROWS,
  )
  expect(ConfigFlightRecorder.resolve({ retention_ms: ConfigFlightRecorder.MAX_RETENTION_MS }).retentionMs).toBe(
    ConfigFlightRecorder.MAX_RETENTION_MS,
  )
  expect(() =>
    ConfigFlightRecorder.resolve({ max_total_requests: ConfigFlightRecorder.MAX_ROWS + 1 }),
  ).toThrow()
  expect(() =>
    ConfigFlightRecorder.resolve({ max_requests_per_session: ConfigFlightRecorder.MAX_ROWS + 1 }),
  ).toThrow()
  expect(() =>
    ConfigFlightRecorder.resolve({ retention_ms: ConfigFlightRecorder.MAX_RETENTION_MS + 1 }),
  ).toThrow()
  // Schema.Int 底层用 Number.isSafeInteger；2^53 不再安全，不能只靠「有限正整数」放行。
  expect(() => ConfigFlightRecorder.resolve({ max_total_requests: Number.MAX_SAFE_INTEGER })).toThrow()
  expect(() => ConfigFlightRecorder.resolve({ max_total_requests: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
  expect(() => ConfigFlightRecorder.resolve({ max_requests_per_session: 2 ** 53 })).toThrow()
  expect(Schema.decodeUnknownSync(ConfigFlightRecorder.Info)({ max_total_requests: 10 })).toEqual({
    max_total_requests: 10,
  })
})

test("retention primitives delete bounded chunks and never cross the configured keep line", async () => {
  await using tmp = await tmpdir()
  const { file, client, db } = await fileDatabase(tmp.path)
  multiset(file, [{ session: sessionA, count: 200, start: 1000, prefix: "a" }])

  let deleted = 0
  let rounds = 0
  while (count(file, sessionA) > 10) {
    deleted = immediate(db, (tx) => trimSession(tx, sessionA, 10))
    expect(deleted).toBeLessThanOrEqual(CLEANUP_CHUNK)
    if (++rounds > 20) throw new Error("per-session trim did not converge")
  }
  expect(rows(file, sessionA)).toEqual(
    Array.from({ length: 10 }, (_, index) => ({ id: `a_${String(199 - index).padStart(4, "0")}` })),
  )

  multiset(file, [
    { session: sessionA, count: 30, start: 5000, prefix: "g_a" },
    { session: sessionB, count: 30, start: 6000, prefix: "g_b" },
  ])
  rounds = 0
  while (count(file) > 25) {
    expect(immediate(db, (tx) => trimGlobal(tx, 25))).toBeLessThanOrEqual(CLEANUP_CHUNK)
    if (++rounds > 20) throw new Error("global trim did not converge")
  }
  expect(rows(file).map((row) => row.id)[0]).toBe("g_b_0029")

  multiset(file, [
    { session: sessionC, count: 5, start: 1, prefix: "old" },
    { session: sessionC, count: 5, start: 10_000, prefix: "new" },
  ])
  rounds = 0
  while (rows(file, sessionC).some((row) => row.id.startsWith("old"))) {
    expect(immediate(db, (tx) => trimByAge(tx, 10_000, 1_000))).toBeLessThanOrEqual(CLEANUP_CHUNK)
    if (++rounds > 20) throw new Error("age trim did not converge")
  }
  expect(rows(file, sessionC).map((row) => row.id).sort()).toEqual([
    "new_0000",
    "new_0001",
    "new_0002",
    "new_0003",
    "new_0004",
  ])

  const beforeRollback = count(file)
  const timeoutBefore = db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)!.timeout
  expect(() =>
    immediate(db, (tx) => {
      trimSession(tx, sessionA, 1)
      throw new Error("rollback")
    }),
  ).toThrow("rollback")
  expect(count(file)).toBe(beforeRollback)
  expect((db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)!).timeout).toBe(timeoutBefore)
  client.close()
})

test("another connection holding the write lock makes a cleanup tick fail without deleting or over-deleting", async () => {
  await using tmp = await tmpdir()
  const { file, client, db } = await fileDatabase(tmp.path)
  multiset(file, [{ session: sessionA, count: 40, start: 1000, prefix: "lock" }])

  const other = new SQLite(file, { create: true })
  other.run("PRAGMA busy_timeout = 0")
  other.run("BEGIN IMMEDIATE")
  expect(() => immediate(db, (tx) => trimSession(tx, sessionA, 5))).toThrow()
  expect(count(file, sessionA)).toBe(40)
  other.run("INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES ('lock_new', ?, 'msg_retention', 9999, 'provider', 'model', '{}')", [sessionA])
  other.run("COMMIT")
  other.close()

  // 释放写锁后边界在新事务里重算：并发插入的新行被保留，只删旧行。
  let rounds = 0
  while (count(file, sessionA) > 5) {
    expect(immediate(db, (tx) => trimSession(tx, sessionA, 5))).toBeLessThanOrEqual(CLEANUP_CHUNK)
    if (++rounds > 20) throw new Error("locked trim did not converge")
  }
  expect(rows(file, sessionA).map((row) => row.id)).toContain("lock_new")
  expect(rows(file, sessionA)).toHaveLength(5)
  client.close()
})

test("an over-cap legacy database converges on startup without any new request", async () => {
  await using tmp = await tmpdir()
  const script = path.resolve(import.meta.dirname, "fixture/flight-retention-writer.ts")
  const result = await Process.run([process.execPath, script, "legacy"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      REDCODE_DB: path.join(tmp.path, "legacy.db"),
      REDCODE_TEST_HOME: path.join(tmp.path, "home"),
    },
    timeout: 60_000,
  })
  expect(result.code, result.stderr.toString()).toBe(0)
  const output = JSON.parse(result.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("RESULT "))!.slice(7))
  expect(output.ok).toBe(true)
  expect(output.legacy.after).toBe(100_000)
  expect(output.legacy.parts).toBe(1)
  expect(output.legacy.sessions).toBe(782)
  expect(output.legacy.stats.limits.totalRequests).toBe(100_000)
  expect(output.legacy.stats.cleanup.ready).toBe(true)
  expect(output.legacy.stats.cleanup.deleted).toBe(96)
})

test("startup reads the real global config before any cleanup (no default over-delete)", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  await mkdir(path.join(home, ".redcode"), { recursive: true })
  await Bun.write(
    path.join(home, ".redcode", "redcode.jsonc"),
    JSON.stringify({ flight_recorder: { max_total_requests: 200_000 } }),
  )
  const script = path.resolve(import.meta.dirname, "fixture/flight-retention-writer.ts")
  const result = await Process.run([process.execPath, script, "config-ok"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      REDCODE_DB: path.join(tmp.path, "config-ok.db"),
      REDCODE_TEST_HOME: home,
    },
    timeout: 60_000,
  })
  expect(result.code, result.stderr.toString()).toBe(0)
  const output = JSON.parse(result.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("RESULT "))!.slice(7))
  expect(output.ok).toBe(true)
  // 旧库 100,096 条，真实配置上限 200,000：启动先按默认 100,000 会误删 96 条。
  expect(output.configOk.before.rows).toBe(100_096)
  expect(output.configOk.after).toBe(100_096)
  expect(output.configOk.limits.totalRequests).toBe(200_000)
  expect(output.configOk.stats.cleanup.ready).toBe(true)
  expect(output.configOk.stats.cleanup.deleted).toBe(0)
})

test("invalid global config never falls back to default cleanup", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  await mkdir(path.join(home, ".redcode"), { recursive: true })
  await Bun.write(
    path.join(home, ".redcode", "redcode.jsonc"),
    JSON.stringify({ flight_recorder: { max_total_requests: 0 } }),
  )
  const script = path.resolve(import.meta.dirname, "fixture/flight-retention-writer.ts")
  const result = await Process.run([process.execPath, script, "config-invalid"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      REDCODE_DB: path.join(tmp.path, "config-invalid.db"),
      REDCODE_TEST_HOME: home,
    },
    timeout: 60_000,
  })
  expect(result.code, result.stderr.toString()).toBe(0)
  const output = JSON.parse(result.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("RESULT "))!.slice(7))
  expect(output.ok).toBe(true)
  expect(output.configInvalid.after).toBe(100_096)
  expect(output.configInvalid.ready).toBe(false)
  expect(output.configInvalid.configError).toBeTruthy()
  expect(output.configInvalid.runs).toBe(0)
})

test("same-tick session deletions recompute the global boundary instead of over-deleting", async () => {
  await using tmp = await tmpdir()
  const script = path.resolve(import.meta.dirname, "fixture/flight-retention-writer.ts")
  const result = await Process.run([process.execPath, script, "stale"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      REDCODE_DB: path.join(tmp.path, "stale.db"),
      REDCODE_TEST_HOME: path.join(tmp.path, "home"),
    },
    timeout: 60_000,
  })
  expect(result.code, result.stderr.toString()).toBe(0)
  const output = JSON.parse(result.stdout.toString().split(/\r?\n/).find((line) => line.startsWith("RESULT "))!.slice(7))
  expect(output.ok).toBe(true)
  // 修正前按每步旧全局边界会继续删 B 的 19 条，最终远低于 82。
  expect(output.stale.sameTick).toBe(82)
  expect(output.stale.crossConnection).toBe(100)
})

test("isolated writer policies converge, including idle ticks and late settlement", async () => {
  await using tmp = await tmpdir()
  const script = path.resolve(import.meta.dirname, "fixture/flight-retention-writer.ts")
  const result = await Process.run([process.execPath, script, "policy"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      REDCODE_DB: path.join(tmp.path, "flight.db"),
      REDCODE_TEST_HOME: path.join(tmp.path, "home"),
    },
    timeout: 40_000,
  })
  expect(result.code, result.stderr.toString()).toBe(0)
  const line = result.stdout
    .toString()
    .split(/\r?\n/)
    .find((value) => value.startsWith("RESULT "))
  expect(line).toBeTruthy()
  const output = JSON.parse(line!.slice("RESULT ".length))
  expect(output.ok).toBe(true)
  expect(output.defaults.keep).toBe(128)
  expect(output.defaults.limits.totalRequests).toBe(100_000)
  expect(output.shrink.rows).toBe(10)
  expect(output.lateSettlement.rows).toBe(10)
  expect(output.global.rows).toBe(20)
  expect(output.retention.rows).toBe(8)
  expect(output.lock.rows).toBe(5)
  expect(output.stats.cleanup.deleted).toBeGreaterThan(0)
  expect(output.stats.cleanup.failures).toBeGreaterThan(0)
  expect(output.stats.dropped).toBe(0)
})
