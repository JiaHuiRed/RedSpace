import { Database as SQLite } from "bun:sqlite"
import { mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"

const [mode, file, hold] = process.argv.slice(2)
if (mode === "--hold-writer") {
  await checkBenchRoot(path.dirname(file))
  if (path.basename(file) !== "flight.db") throw new Error("Expected a benchmark database")
  using db = new SQLite(file)
  db.run("BEGIN IMMEDIATE")
  await Bun.write(Bun.stdout, "locked\n")
  await Bun.sleep(Number(hold))
  db.run("ROLLBACK")
} else if (mode === "--run") {
  await bench(await checkBenchRoot(file))
} else {
  await runIsolated()
}

async function runIsolated() {
  const root = await mkdtemp(path.join(tmpdir(), "redcode-flight-bench-"))
  try {
    const child = Bun.spawn([process.execPath, "--conditions=browser", import.meta.path, "--run", root], {
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(120_000),
    })
    process.exitCode = await child.exited
  } finally {
    await rm(await checkBenchRoot(root), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
}

async function checkBenchRoot(root: string) {
  const resolved = await realpath(root)
  if (
    path.dirname(resolved) !== (await realpath(tmpdir())) ||
    !path.basename(resolved).startsWith("redcode-flight-bench-")
  ) {
    throw new Error("Expected an isolated flight benchmark directory")
  }
  return resolved
}

async function bench(root: string) {
  const file = path.join(root, "flight.db")
  process.env.REDCODE_TEST_HOME = root
  process.env.REDCODE_DB = file
  const Log = await import("@redcode-ai/core/util/log")
  await Log.init({ print: true, level: "ERROR" })

  const { Database } = await import("../src/storage/db")
  const { FlightRecording } = await import("../src/session/flight-recording")
  const { stats } = await import("../src/session/flight-request-writer")
  const { RequestEvidence } = await import("../src/session/request-evidence")
  const { SessionID, MessageID } = await import("../src/session/schema")
  const { ModelID, ProviderID } = await import("../src/provider/schema")
  const { LLMEvent } = await import("@redcode-ai/llm")
  const { Exit } = await import("effect")

  const db = Database.Client().$client
  const body = JSON.stringify({ model: "bench", messages: [{ role: "user", content: "flight bench" }] })
  const scenarios = [
    { name: "steady", sessions: 1, rounds: 192, history: 0, holdMs: 0, mixed: false, readonly: false },
    { name: "fanout-large", sessions: 16, rounds: 96, history: 8192, holdMs: 0, mixed: true, readonly: false },
    { name: "writer-lock", sessions: 1, rounds: 12, history: 128, holdMs: 180, mixed: false, readonly: false },
    { name: "writer-lock-expired", sessions: 1, rounds: 6, history: 128, holdMs: 450, mixed: false, readonly: false },
    { name: "write-failure", sessions: 1, rounds: 40, history: 0, holdMs: 0, mixed: true, readonly: true },
  ]

  try {
    for (const scenario of scenarios) {
      for (const enabled of [false, true]) {
        db.run("DELETE FROM project WHERE id = 'prj_flight_bench'")
        RequestEvidence.reset()
        seed(db, scenario.sessions, scenario.history)
        db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        if (scenario.readonly) db.run("PRAGMA query_only = ON")
        const loop = monitorEventLoopDelay({ resolution: 2 })
        loop.enable()
        const outbound: number[] = []
        const firstEvent: number[] = []
        const hooks: number[] = []
        const batches: number[] = []
        const before = stats()
        let seen = before.batches
        const sampleBatch = () => {
          const sample = stats()
          if (sample.batches === seen) return
          seen = sample.batches
          batches.push(sample.lastWriteMs)
        }
        const attempts: { id: string; session: string; time: number }[] = []
        const observers = Array.from({ length: scenario.sessions }, (_, index) => {
          const session = `ses_flight_bench_${index}`
          const recorder = enabled
            ? FlightRecording.create({
                sessionID: SessionID.make(session),
                messageID: MessageID.make(`msg_flight_bench_${index}`),
                providerID: ProviderID.make("bench"),
                modelID: ModelID.make("bench"),
                runtime: "ai-sdk",
              })
            : undefined
          const observer = RequestEvidence.create(
            { sessionID: session, modelKey: "bench/bench", runtime: "ai-sdk" },
            undefined,
            recorder && {
              ...recorder,
              started(...args) {
                attempts.push({ id: args[0], session, time: args[1] })
                const at = performance.now()
                recorder.started(...args)
                hooks.push(performance.now() - at)
              },
            },
          )
          return { recorder, observer }
        })

        const request = async (pair: (typeof observers)[number], rejected = false) => {
          const started = performance.now()
          const middleware = RequestEvidence.middleware(pair.observer)
          const result = await middleware
            .wrapStream({
              doStream: async () => {
                outbound.push(performance.now() - started)
                await Bun.sleep(2)
                if (rejected) throw new Error("simulated HTTP 503")
                return {
                  request: { body },
                  stream: new ReadableStream({
                    start(controller) {
                      controller.enqueue({
                        type: "finish",
                        usage: { raw: { prompt_tokens: 100, completion_tokens: 10 } },
                      })
                      controller.close()
                    },
                  }),
                }
              },
            })
            .catch((error: Error) => {
              if (!rejected || error.message !== "simulated HTTP 503") throw error
            })
          if (!result) return
          firstEvent.push(performance.now() - started)
          pair.observer.event(LLMEvent.textStart({ id: "fixture" }))
          const reader = result.stream.getReader()
          while (!(await reader.read()).done) {
            // 261126 Red 消费模拟供应商 finish，经过真实 middleware 的按请求结算接缝。
          }
        }

        await Bun.sleep(8)
        try {
          for (let round = 0; round < scenario.rounds; round++) {
            const lock = scenario.holdMs ? await holdWriter(file, scenario.holdMs) : undefined
            await Promise.all(
              observers.map(async (pair) => {
                if (scenario.mixed && round % 16 === 0) await request(pair, true)
                await request(pair)
                if (scenario.mixed && round % 12 === 0) await request(pair)
                const at = performance.now()
                pair.recorder?.settle(Exit.succeed(undefined))
                if (enabled) hooks.push(performance.now() - at)
              }),
            )
            if (lock && (await lock.exited) !== 0) throw new Error("SQLite lock holder failed")
            sampleBatch()
          }
          await Bun.sleep(30)
          const deadline = performance.now() + 1000
          while (stats().pending > 0 && performance.now() < deadline) {
            await Bun.sleep(5)
            sampleBatch()
          }
          const writes = stats()
          if (writes.pending > 0) throw new Error("Benchmark writer did not drain")
          if (db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout !== 5000) {
            throw new Error("Recorder changed the main connection's busy timeout")
          }
          const expected = new Map<string, { id: string; time: number }[]>()
          for (const attempt of attempts) {
            const list = expected.get(attempt.session) ?? []
            list.push(attempt)
            expected.set(attempt.session, list)
          }
          const present = new Set(
            db
              .query("SELECT id FROM flight_request")
              .all()
              .map((row) => (row as { id: string }).id),
          )
          const missing = [...expected.values()]
            .flatMap((list) =>
              list
                .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
                .slice(0, FlightRecording.KEEP_PER_SESSION),
            )
            .filter((row) => !present.has(row.id)).length
          console.log(
            JSON.stringify({
              scenario: scenario.name,
              enabled,
              attempts: outbound.length,
              hookMs: percentiles(hooks),
              outboundMs: percentiles(outbound),
              firstEventMs: percentiles(firstEvent),
              sampledBatchMs: percentiles(batches),
              writeBatches: writes.batches - before.batches,
              droppedWrites: writes.dropped - before.dropped,
              loopDelayMs: [50, 95, 99].map((p) => roundMs(loop.percentile(p) / 1e6)),
              walBytes: (await stat(`${file}-wal`)).size,
              missingRetainedRows: missing,
            }),
          )
        } finally {
          loop.disable()
          if (scenario.readonly) db.run("PRAGMA query_only = OFF")
        }
      }
    }
  } finally {
    Database.close()
  }
}

function seed(db: SQLite, sessions: number, history: number) {
  db.transaction(() => {
    db.run(
      "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('prj_flight_bench', '/bench', '[]', 0, 0)",
    )
    const session = db.query(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_flight_bench', 'bench', '/bench', 'Flight bench', 'bench', 0, 0)",
    )
    const message = db.query(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 0, 0, \'{"role":"assistant"}\')',
    )
    const attempt = db.query(
      "INSERT INTO flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) VALUES (?, ?, ?, ?, 'bench', 'bench', '{\"outcome\":\"completed\"}')",
    )
    for (let index = 0; index < Math.max(sessions, Math.ceil(history / 128)); index++) {
      session.run(`ses_flight_bench_${index}`)
      message.run(`msg_flight_bench_${index}`, `ses_flight_bench_${index}`)
    }
    for (let index = 0; index < history; index++) {
      const owner = Math.floor(index / 128)
      attempt.run(`old_flight_bench_${index}`, `ses_flight_bench_${owner}`, `msg_flight_bench_${owner}`, index)
    }
  })()
}

async function holdWriter(file: string, ms: number) {
  const child = Bun.spawn([process.execPath, import.meta.path, "--hold-writer", file, String(ms)], {
    stdout: "pipe",
    stderr: "inherit",
    signal: AbortSignal.timeout(5000),
  })
  const reader = child.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  if (new TextDecoder().decode(ready.value).trim() !== "locked") throw new Error("SQLite lock holder did not start")
  return child
}

function roundMs(value: number) {
  return Math.round(value * 1000) / 1000
}
function percentiles(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b)
  return sorted.length ? [50, 95, 99].map((p) => roundMs(sorted[Math.ceil((p * sorted.length) / 100) - 1]!)) : undefined
}
