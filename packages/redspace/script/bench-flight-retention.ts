import { Database as SQLite } from "bun:sqlite"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { cpus, tmpdir, totalmem } from "node:os"
import path from "node:path"
import type { RequestData } from "../src/session/flight-recording"

// 261126 Red FR-05 前置测量：合成数据 + 独立临时 DB，不导入 Database/Writer 运行时，
// 也不读取 REDCODE_DB 或用户真实数据。被测 SQL 与 DDL 抄自：
//   flight-request-writer.ts 的 KEEP_PER_SESSION / BATCH_SIZE / 窗口裁剪语句
//   flight-request.sql.ts 与 migration/20261126032553_flight_request 的列和索引
// 运行：bun run script/bench-flight-retention.ts --scales=10000,100000 [--out=file.json]

const KEEP_PER_SESSION = 128
const BATCH_SIZE = 32
const EVICT_BATCH = 1024
const PROVIDERS = ["anthropic", "openai", "google"]
const MODELS = ["claude-sonnet-4-5-20250929", "gpt-5-codex", "gemini-3-pro"]
const startedAt = performance.now()

const options = new Map(
  process.argv.slice(2).map((value) => {
    const at = value.indexOf("=")
    return at === -1 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)]
  }),
)
const scales = (options.get("--scales") ?? "10000,100000,1000000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0)
const out = options.get("--out")
const keep = options.has("--keep")
const withBacklog = !options.has("--no-backlog")

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    bun: Bun.version,
    sqlite: undefined as string | undefined,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    memoryBytes: totalmem(),
    keepPerSession: KEEP_PER_SESSION,
    batchSize: BATCH_SIZE,
    evictBatch: EVICT_BATCH,
    payload:
      "RequestData 合成分布：70% 已采集完成、15% unsupported 失败、10% 最小未知、5% 已采集且压缩；" +
      "id/session/message 为 28 字符定长 ID，provider/model 三组循环",
  },
  scales: [] as ScaleResult[],
}

let root = ""

async function main() {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "redcode-flight-fr05-")))
  if (path.dirname(root) !== (await realpath(tmpdir())) || !path.basename(root).startsWith("redcode-flight-fr05-")) {
    throw new Error("Expected an isolated FR-05 benchmark directory")
  }
  try {
    for (const rows of scales) {
      const result = await measureScale(rows)
      report.scales.push(result)
      printScale(result)
    }
    if (out) await Bun.write(out, JSON.stringify(report, null, 2))
  } finally {
    if (keep) console.log(`kept benchmark root: ${root}`)
    else await removeRoot(root)
  }
  console.log(JSON.stringify({ out, scales, elapsedMs: round(performance.now() - startedAt) }))
}

async function removeRoot(dir: string) {
  // 261126 Red Windows 上关闭 SQLite 后句柄可能短暂滞留，EBUSY 以退避重试收尾。
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 39) {
        console.warn(`benchmark root left behind (${String(error)}): ${dir}`)
        return
      }
      await Bun.sleep(500)
    }
  }
}

// ---------- scale ----------

async function measureScale(rows: number) {
  const dir = path.join(root, `rows-${rows}`)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "flight.db")
  const db = open(file)
  const sessions = Math.max(1, Math.ceil(rows / KEEP_PER_SESSION))
  report.meta.sqlite ??= (db.query("SELECT sqlite_version() AS version").get() as { version: string }).version
  console.log(`rows=${rows} starting (sessions=${sessions})`)

  try {
    createSchema(db)
    seedParents(db, sessions)
    const insertMs = timeIt(() => fill(db, 0, rows, (index) => index % sessions, (index) => Math.floor(index / 4)))
    const walBytesAfterInsert = await size(`${file}-wal`)
    const beforeIndex = await dbStats(db, file)
    const checkpoint = checkpointNow(db)
    const afterCheckpoint = await dbStats(db, file)
    const logical = db
      .query(
        `SELECT COUNT(*) AS rows,
          SUM(LENGTH(CAST(data AS BLOB))) AS dataBytes,
          SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(session_id AS BLOB)) + LENGTH(CAST(message_id AS BLOB)) +
            LENGTH(CAST(provider_id AS BLOB)) + LENGTH(CAST(model_id AS BLOB))) AS metaBytes
        FROM flight_request`,
      )
      .get() as { rows: number; dataBytes: number; metaBytes: number }

    const indexes: IndexBuild[] = []
    for (const index of INDEXES) {
      const before = await dbStats(db, file)
      const ms = timeIt(() => db.run(index.sql))
      checkpointNow(db)
      const after = await dbStats(db, file)
      indexes.push({
        name: index.name,
        ms: round(ms),
        pageBytes: after.pageBytes - before.pageBytes,
        fileBytes: after.fileBytes - before.fileBytes,
        bytesPerRow: round((after.pageBytes - before.pageBytes) / rows),
      })
    }
    const final = await dbStats(db, file)

    const plans = {
      perSession: plan(db, pruneSQL(4), [0, 1, 2, 3]),
      wide: plan(db, pruneSQL(BATCH_SIZE), Array.from({ length: BATCH_SIZE }, (_, index) => index)),
      globalTime: plan(db, GLOBAL_TIME_RANGE, [0]),
      globalRowValue: plan(db, GLOBAL_ROW_VALUE, [0, ""]),
      globalCapacity: plan(db, GLOBAL_CAPACITY, [EVICT_BATCH]),
    }

    const perSessionPrune = pruneTiming(db, rows, [0, 1, 2, 3], 8, 20, plans.perSession, Math.floor(rows / 4) + 1000)
    const widePrune = pruneTiming(
      db,
      perSessionPrune.nextIndex,
      Array.from({ length: BATCH_SIZE }, (_, index) => index),
      1,
      20,
      plans.wide,
      perSessionPrune.nextTime,
    )
    const walBytesSteady = await size(`${file}-wal`)
    // 261126 Red 两种批量：1024 行是容量巡检/清理的批量，32 行与写入批同尺寸，便于和每会话裁剪同口径比较。
    const globalEviction = globalTiming(db, widePrune.nextIndex, EVICT_BATCH, 20)
    const globalEvictionSmall = globalTiming(db, globalEviction.nextIndex, BATCH_SIZE, 20)
    const oneShot = await oneShotEviction(db, file, rows)
    const capacity = {
      rows,
      sessions,
      insertMs: round(insertMs),
      checkpoint,
      walBytesAfterInsert,
      walBytesSteady,
      pages: { beforeIndex, afterCheckpoint, final },
      logical,
      perRow: {
        fileBytes: round(final.fileBytes / rows),
        pageBytes: round(final.pageBytes / rows),
        dataBytes: round(logical.dataBytes / rows),
        metaBytes: round(logical.metaBytes / rows),
        indexBytes: round(indexes.reduce((total, index) => total + index.pageBytes, 0) / rows),
      },
      indexes,
      totalIndexMs: round(indexes.reduce((total, index) => total + index.ms, 0)),
    }

    return {
      rows,
      capacity,
      plans,
      perSessionPrune,
      widePrune,
      backlog: withBacklog ? await measureBacklog(dir, rows) : undefined,
      globalEviction: globalEviction.variants,
      globalEvictionSmall: globalEvictionSmall.variants,
      oneShot,
    }
  } finally {
    db.close()
  }
}

async function measureBacklog(dir: string, rows: number) {
  const file = path.join(dir, "backlog.db")
  const db = open(file)
  try {
    createSchema(db)
    seedParents(db, 1)
    fill(db, 0, rows, () => 0, (index) => Math.floor(index / 4))
    for (const index of INDEXES) db.run(index.sql)
    fill(db, rows, BATCH_SIZE, () => 0, (index) => Math.floor(index / 4) + 1)
    const before = count(db)
    const stmt = db.query(pruneSQL(1))
    const ms = timeIt(() => stmt.run(sessionID(0)))
    checkpointNow(db)
    return {
      rows,
      batch: BATCH_SIZE,
      before,
      after: count(db),
      deleted: before - count(db),
      pruneMs: round(ms),
      plan: plan(db, pruneSQL(1), [0]),
    }
  } finally {
    db.close()
  }
}

function pruneTiming(
  db: SQLite,
  startIndex: number,
  sessions: number[],
  perSession: number,
  rounds: number,
  planRows: string[],
  startTime: number,
) {
  const stmt = db.query(pruneSQL(sessions.length))
  const insertSamples: number[] = []
  const pruneSamples: number[] = []
  const deletions: number[] = []
  const warmup = 3
  let index = startIndex
  let time = startTime
  let baseline = 0
  for (let round = 0; round < warmup + rounds; round++) {
    const insertMs = timeIt(() => {
      const insert = db.query(INSERT_SQL)
      db.transaction(() => {
        for (const session of sessions) {
          for (let offset = 0; offset < perSession; offset++) {
            insert.run(
              rowID(index),
              sessionID(session),
              messageID(session),
              time,
              PROVIDERS[index % PROVIDERS.length],
              MODELS[index % MODELS.length],
              JSON.stringify(payload(index)),
            )
            index++
            if (index % 4 === 0) time++
          }
        }
      })()
    })
    if (round < warmup) {
      stmt.run(...sessions.map(sessionID))
      continue
    }
    const ms = timeIt(() => {
      deletions.push(stmt.run(...sessions.map(sessionID)).changes)
    })
    insertSamples.push(insertMs)
    pruneSamples.push(ms)
    if (round === warmup) baseline = count(db)
    else if (count(db) !== baseline) throw new Error("Per-session prune did not hold the table at steady state")
  }
  if (deletions.some((value) => value === 0)) throw new Error("Per-session prune deleted nothing at steady state")
  return {
    sessions: sessions.length,
    perSession,
    rounds,
    plan: planRows,
    insertMs: summarize(insertSamples),
    pruneMs: summarize(pruneSamples),
    deleted: summarize(deletions),
    nextIndex: index,
    nextTime: time,
  }
}

function globalTiming(db: SQLite, startIndex: number, batch: number, rounds: number) {
  const maxTime = (db.query("SELECT MAX(time_created) AS time FROM flight_request").get() as { time: number }).time
  let index = startIndex
  let time = maxTime + 1
  const variants = [
    { name: "timeRange", sql: GLOBAL_TIME_RANGE, plan: plan(db, GLOBAL_TIME_RANGE, [0]) },
    { name: "rowValue", sql: GLOBAL_ROW_VALUE, plan: plan(db, GLOBAL_ROW_VALUE, [0, ""]) },
    { name: "capacity", sql: GLOBAL_CAPACITY, plan: plan(db, GLOBAL_CAPACITY, [batch]) },
  ] as const

  const result = Object.fromEntries(
    variants.map((variant) => {
      const stmt = db.query(variant.sql)
      const samples: number[] = []
      const deletions: number[] = []
      for (let round = 0; round < rounds; round++) {
        const edge =
          variant.name === "capacity"
            ? undefined
            : (db.query("SELECT time_created, id FROM flight_request ORDER BY time_created, id LIMIT 1 OFFSET ?").get(
                batch - 1,
              ) as { time_created: number; id: string })
        const params =
          variant.name === "capacity" ? [batch] : variant.name === "rowValue" ? [edge!.time_created, edge!.id] : [edge!.time_created]
        let deleted = 0
        const ms = timeIt(() => {
          deleted = (stmt.run(...(params as never[])) as { changes: number }).changes
        })
        if (deleted === 0) throw new Error(`Global eviction ${variant.name} deleted nothing`)
        samples.push(ms)
        deletions.push(deleted)
        const insert = db.query(INSERT_SQL)
        db.transaction(() => {
          for (let offset = 0; offset < deleted; offset++) {
            insert.run(
              rowID(index),
              sessionID(0),
              messageID(0),
              time + Math.floor(offset / 4),
              PROVIDERS[index % PROVIDERS.length],
              MODELS[index % MODELS.length],
              JSON.stringify(payload(index)),
            )
            index++
          }
        })()
        time += Math.ceil(deleted / 4) + 1
      }
      return [
        variant.name,
        {
          batch,
          rounds,
          plan: variant.plan,
          ms: summarize(samples),
          deleted: summarize(deletions),
          totalMs: round(samples.reduce((total, value) => total + value, 0)),
          totalDeleted: deletions.reduce((total, value) => total + value, 0),
        },
      ]
    }),
  ) as Record<"timeRange" | "rowValue" | "capacity", GlobalVariant>
  return { nextIndex: index, variants: result }
}

async function oneShotEviction(db: SQLite, file: string, rows: number) {
  const target = Math.max(1000, Math.floor(rows / 10))
  const before = count(db)
  const capacityMs = timeIt(() => {
    const deleted = (db.query(GLOBAL_CAPACITY).run(target) as { changes: number }).changes
    if (deleted !== target) throw new Error("Global capacity one-shot did not delete the requested rows")
  })
  const edge = db.query("SELECT time_created, id FROM flight_request ORDER BY time_created, id LIMIT 1 OFFSET ?").get(target - 1) as {
    time_created: number
    id: string
  }
  let timeDeleted = 0
  const timeRangeMs = timeIt(() => {
    timeDeleted = (db.query(GLOBAL_TIME_RANGE).run(edge.time_created) as { changes: number }).changes
  })
  checkpointNow(db)
  return {
    target,
    before,
    after: count(db),
    capacityDeleted: target,
    timeDeleted,
    capacityMs: round(capacityMs),
    timeRangeMs: round(timeRangeMs),
    fileBytes: (await dbStats(db, file)).fileBytes,
    freelist: (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
  }
}

// ---------- storage and query helpers ----------

const INSERT_SQL =
  "INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES (?,?,?,?,?,?,?)"

const INDEXES = [
  {
    name: "flight_request_session_time_created_id_idx",
    sql: "CREATE INDEX flight_request_session_time_created_id_idx ON flight_request (session_id, time_created, id)",
  },
  {
    name: "flight_request_message_id_idx",
    sql: "CREATE INDEX flight_request_message_id_idx ON flight_request (message_id)",
  },
  {
    // 261126 Red 仅在测「全局时间索引淘汰」时才需要的新增索引；V1 现网没有。
    name: "flight_request_time_created_id_idx",
    sql: "CREATE INDEX flight_request_time_created_id_idx ON flight_request (time_created, id)",
  },
] as const

const GLOBAL_TIME_RANGE = "DELETE FROM flight_request WHERE time_created < ?"
const GLOBAL_ROW_VALUE = "DELETE FROM flight_request WHERE (time_created, id) < (?, ?)"
const GLOBAL_CAPACITY = "DELETE FROM flight_request WHERE id IN (SELECT id FROM flight_request ORDER BY time_created, id LIMIT ?)"

function pruneSQL(sessions: number) {
  return `DELETE FROM flight_request WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY time_created DESC, id DESC) AS position
    FROM flight_request WHERE session_id IN (${Array.from({ length: sessions }, () => "?").join(",")})
  ) WHERE position > ${KEEP_PER_SESSION}
)`
}

function open(file: string) {
  const db = new SQLite(file, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA wal_checkpoint(PASSIVE)")
  return db
}

function createSchema(db: SQLite) {
  // 父表只保留外键目标列；flight_request DDL 与列名逐字来自迁移。
  db.run("CREATE TABLE session (id text PRIMARY KEY)")
  db.run("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE)")
  db.run(`CREATE TABLE flight_request (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  message_id text NOT NULL,
  time_created integer NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  data text NOT NULL,
  CONSTRAINT fk_flight_request_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
  CONSTRAINT fk_flight_request_message_id_message_id_fk FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
)`)
}

function seedParents(db: SQLite, sessions: number) {
  const session = db.query("INSERT INTO session (id) VALUES (?)")
  const message = db.query("INSERT INTO message (id, session_id) VALUES (?, ?)")
  db.transaction(() => {
    for (let index = 0; index < sessions; index++) {
      session.run(sessionID(index))
      message.run(messageID(index), sessionID(index))
    }
  })()
}

function fill(
  db: SQLite,
  start: number,
  count: number,
  sessionFor: (index: number) => number,
  timeFor: (index: number) => number,
) {
  const insert = db.query(INSERT_SQL)
  db.transaction(() => {
    for (let offset = 0; offset < count; offset++) {
      const index = start + offset
      const session = sessionFor(index)
      insert.run(
        rowID(index),
        sessionID(session),
        messageID(session),
        timeFor(index),
        PROVIDERS[index % PROVIDERS.length],
        MODELS[index % MODELS.length],
        JSON.stringify(payload(index)),
      )
    }
  })()
}

function payload(index: number): RequestData {
  const slot = index % 20
  if (slot >= 14 && slot <= 16)
    return {
      outcome: "failed",
      durationMs: 300 + (index % 900),
      diagnostics: {
        version: 1,
        runtime: "native",
        capture: { status: "unsupported", reason: "unsupported-shape" },
        unattributedInputTokens: 1200 + (index % 300),
      },
    }
  if (slot >= 17) return { outcome: "unknown", diagnostics: { version: 1, runtime: "ai-sdk" } }
  const input = 18000 + (index % 9000)
  const cacheRead = Math.min(input, 11000 + (index % 5000))
  const compressed = slot === 19
  return {
    outcome: "completed",
    input,
    output: 400 + (index % 900),
    cacheRead,
    cacheWrite: index % 7 === 0 ? 1200 : 0,
    cacheMiss: input - cacheRead,
    durationMs: 1200 + (index % 5000),
    firstEventMs: 300 + (index % 1200),
    prefix: { system: "unchanged", tools: "unchanged", history: compressed ? "rewrite" : "append", compressed },
    diagnostics: {
      version: 1,
      runtime: "ai-sdk",
      capture: {
        status: "captured",
        previousRequestID: rowID(Math.max(0, index - 1)),
        system: { change: "unchanged", count: 2, bytes: 13824, countDelta: 0, bytesDelta: 0, firstDifference: 1244 },
        tools: { change: "unchanged", count: 18, bytes: 22110 },
        history: {
          change: compressed ? "rewrite" : "append",
          count: 40 + (index % 30),
          bytes: 32000 + (index % 9000),
          countDelta: 2,
          bytesDelta: 3000 + (index % 800),
        },
        ...(compressed
          ? {
              compacted: true as const,
              compression: {
                receipts: 3,
                blockCount: 42,
                inputTokensEstimated: 52000,
                summaryTokensEstimated: 8000,
                netSavingsEstimated: 44000,
              },
            }
          : {}),
        parameters: "unchanged",
        wire: "unchanged",
        serialized: compressed ? "changed" : "unchanged",
        affinity: "unchanged",
      },
      instructions: { source: "provider", inputTokens: 1240, cachedTokens: 1024, cacheWriteTokens: 0, missTokens: 216 },
      unattributedInputTokens: 12 + (index % 40),
    },
  }
}

function rowID(index: number) {
  return `req_${index.toString(36).padStart(24, "0")}`
}

function sessionID(index: number) {
  return `ses_${index.toString(36).padStart(24, "0")}`
}

function messageID(index: number) {
  return `msg_${index.toString(36).padStart(24, "0")}`
}

function plan(db: SQLite, sql: string, params: unknown[]) {
  // 261126 Red bun:sqlite 的 EXPLAIN QUERY PLAN 读完不会自动结束语句，残留会让后续事务
  // COMMIT 报 "SQL statements in progress"，这里显式 finalize。
  const stmt = db.query("EXPLAIN QUERY PLAN " + sql)
  try {
    return (stmt.all(...(params as never[])) as { detail: string }[]).map((row) => row.detail)
  } finally {
    stmt.finalize()
  }
}

function count(db: SQLite) {
  return (db.query("SELECT COUNT(*) AS count FROM flight_request").get() as { count: number }).count
}

function checkpointNow(db: SQLite) {
  const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number }
  if (result.busy !== 0) throw new Error("WAL checkpoint was blocked")
  return result
}

async function dbStats(db: SQLite, file: string) {
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size
  const pageCount = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
  const freelist = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
  return {
    fileBytes: await size(file),
    walBytes: await size(`${file}-wal`),
    pageSize,
    pageCount,
    freelist,
    pageBytes: pageSize * pageCount,
  }
}

async function size(file: string) {
  return stat(file).then(
    (value) => value.size,
    () => 0,
  )
}

function timeIt(fn: () => void) {
  const started = performance.now()
  fn()
  return performance.now() - started
}

function summarize(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right)
  const at = (percentile: number) => sorted[Math.max(0, Math.ceil((percentile * sorted.length) / 100) - 1)]!
  return {
    count: samples.length,
    min: round(sorted[0]!),
    p50: round(at(50)),
    p95: round(at(95)),
    max: round(sorted[sorted.length - 1]!),
    mean: round(samples.reduce((total, value) => total + value, 0) / samples.length),
  }
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}

type Summary = ReturnType<typeof summarize>
type IndexBuild = { name: string; ms: number; pageBytes: number; fileBytes: number; bytesPerRow: number }
type GlobalVariant = { batch: number; rounds: number; plan: string[]; ms: Summary; deleted: Summary; totalMs: number; totalDeleted: number }
type ScaleResult = Awaited<ReturnType<typeof measureScale>>

function printScale(value: ScaleResult) {
  const capacity = value.capacity
  console.log(
    [
      `rows=${value.rows} sessions=${capacity.sessions}`,
      `insert=${capacity.insertMs}ms`,
      `file=${mb(capacity.pages.final.fileBytes)} walPeak=${mb(capacity.walBytesAfterInsert)}`,
      `perRow(file/data/meta/index)=${capacity.perRow.fileBytes}/${capacity.perRow.dataBytes}/${capacity.perRow.metaBytes}/${capacity.perRow.indexBytes}B`,
      `indexBuild=${capacity.indexes.map((index) => `${index.name.split("_")[2]}:${index.ms}ms`).join(" ")}`,
      `prune4=${ms(value.perSessionPrune.pruneMs)}`,
      `prune32=${ms(value.widePrune.pruneMs)}`,
      `global${EVICT_BATCH}=${["timeRange", "rowValue", "capacity"].map((name) => `${name}:${ms(value.globalEviction[name as keyof typeof value.globalEviction].ms)}`).join(" ")}`,
      `global${BATCH_SIZE}=${["timeRange", "rowValue", "capacity"].map((name) => `${name}:${ms(value.globalEvictionSmall[name as keyof typeof value.globalEvictionSmall].ms)}`).join(" ")}`,
      value.backlog ? `backlogDelete=${value.backlog.deleted}@${value.backlog.pruneMs}ms` : "",
    ]
      .filter(Boolean)
      .join(" "),
  )
}

function mb(bytes: number) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`
}

function ms(value: Summary) {
  return `${value.p50}/${value.p95}ms`
}

await main()
