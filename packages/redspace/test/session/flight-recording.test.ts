import { describe, expect, spyOn, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { LLMEvent, ToolResultValue } from "@redcode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@redcode-ai/llm/route"
import { type ModelMessage, streamText, wrapLanguageModel } from "ai"
import { Effect, Exit, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { Database } from "@/storage/db"
import { FlightRequestTable } from "@/session/flight-request.sql"
import * as Writer from "@/session/flight-request-writer"
import { FlightRecording } from "@/session/flight-recording"
import { RequestEvidence } from "@/session/request-evidence"
import { ConfigRequestEvidence } from "@/config/request-evidence"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("gpt-5-mini"),
  providerID: ProviderID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const provider: Provider.Info = {
  id: ProviderID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const clientLayer = LLMClient.layer.pipe(
  Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)),
)
const it = testEffect(clientLayer)

// 261126 Red 测试直接写真实表：project/session/message 先落库，flight_request 的复合外键
// 才有宿主可挂；每条用例用独立 session/message，互不干扰。
function seed(sessionID: string, messageID: string) {
  const db = Database.Client().$client
  db.run(
    "INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
    ["prj_flight", "/flight", "[]", 0, 0],
  )
  db.run(
    "INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [sessionID, "prj_flight", "flight", "/flight", "Flight", "test", 0, 0],
  )
  db.run(
    "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    [messageID, sessionID, 0, 0, '{"role":"assistant"}'],
  )
}

const rows = (sessionID: string) => {
  let queued = Writer.stats().pending
  while (queued > 0) {
    Writer.flush()
    const remaining = Writer.stats().pending
    expect(remaining).toBeLessThan(queued)
    queued = remaining
  }
  return Database.use((db) =>
    db
      .select()
      .from(FlightRequestTable)
      .where(eq(FlightRequestTable.session_id, SessionID.make(sessionID)))
      .all(),
  )
}

const flightFor = (sessionID: string, messageID: string, runtime: "ai-sdk" | "native" = "ai-sdk", anthropic = false) =>
  FlightRecording.create({
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make(messageID),
    providerID: model.providerID,
    modelID: model.id,
    runtime,
    anthropic,
  })

const context = (
  sessionID: string,
  modelKey = `${model.providerID}/${model.id}`,
  runtime: "ai-sdk" | "native" = "ai-sdk",
) => ({ sessionID, modelKey, runtime, model })

const chatBody = (history = "first turn", system = "private flight system") => ({
  messages: [
    { role: "system", content: system },
    { role: "user", content: history },
  ],
  tools: [],
})

type Captured = Extract<ReturnType<ReturnType<typeof RequestEvidence.create>["capture"]>, { status: "captured" }>

const captured = (observation: ReturnType<ReturnType<typeof RequestEvidence.create>["capture"]>): Captured => {
  if (observation.status !== "captured") throw new Error(`Expected captured body, got ${observation.reason}`)
  return observation
}

// 261126 Red 生产两路都经 withRequest 登记出站；测试同样走它，保证 started 是唯一插入点。
const observe = (observer: ReturnType<typeof RequestEvidence.create>, body: unknown): Captured =>
  captured(RequestEvidence.withRequest(observer, () => observer.capture(body)))

const interruptExit = () => Effect.runSync(Effect.exit(Effect.interrupt))

const sse = (chunks: readonly string[]) =>
  new Response([...chunks.flatMap((chunk) => [`data: ${chunk}`, ""]), "data: [DONE]", ""].join("\n"), {
    headers: { "Content-Type": "text/event-stream" },
  })

const successSse = (cached: number | undefined, raw: Record<string, number> = {}) =>
  sse([
    JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
        ...raw,
      },
    }),
  ])

const brokenSse = sse(['{"choices":['])

type AdapterPart = Parameters<typeof LLMAISDK.toLLMEvents>[1]

async function feed(observer: ReturnType<typeof RequestEvidence.create>, stream: ReadableStream<AdapterPart>) {
  const state = LLMAISDK.adapterState()
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return
    for (const event of await Effect.runPromise(LLMAISDK.toLLMEvents(state, next.value))) observer.event(event)
  }
}

test("attempt latency uses a monotonic clock and ends at the provider finish before tool work", () => {
  const sessionID = "ses_flight_duration"
  const messageID = "msg_flight_duration"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const now = spyOn(performance, "now").mockReturnValue(100)
  try {
    flight.started("attempt", 5000)
    now.mockReturnValue(110)
    flight.event(LLMEvent.textStart({ id: "text" }), undefined)
    now.mockReturnValue(140)
    flight.providerUsage({ requestID: "attempt", cachedTokens: "missing", fields: {} })
    now.mockReturnValue(2040)
    flight.settle(Exit.succeed(undefined))
    expect(rows(sessionID)[0]).toMatchObject({
      time_created: 5000, data: { outcome: "completed", firstEventMs: 10, durationMs: 40 },
    })
  } finally {
    now.mockRestore()
  }
})

function chatLanguageModel(observer: ReturnType<typeof RequestEvidence.create>, fetch: typeof globalThis.fetch) {
  const compatible = createOpenAICompatible({
    name: "flight-test",
    baseURL: "https://flight.test/v1",
    apiKey: "test-key",
    fetch,
  })
  return wrapLanguageModel({
    model: compatible.chatModel("fixture-model"),
    middleware: [RequestEvidence.middleware(observer)],
  })
}

// 261126 Red 真实 middleware + 真实 AI SDK 流：每次 streamText 是一次真实请求尝试，
// capture 来自 wrapStream 拿到的实际出站 body；事件经生产适配层喂回观察器。
async function drive(
  observer: ReturnType<typeof RequestEvidence.create>,
  languageModel: Parameters<typeof streamText>[0]["model"],
  messages: ModelMessage[],
) {
  const state = LLMAISDK.adapterState()
  const result = streamText({ model: languageModel, messages, allowSystemInMessages: true, maxRetries: 0 })
  try {
    for await (const part of result.fullStream) {
      for (const event of await Effect.runPromise(LLMAISDK.toLLMEvents(state, part))) observer.event(event)
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

// 261126 Red 真实 middleware 多尝试：成功、失败、再成功各一行，互不汇总。
test("records independent rows for real middleware attempts including a failure", async () => {
  const sessionID = "ses_flight_middleware"
  const messageID = "msg_flight_middleware"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const observer = RequestEvidence.create(context(sessionID), ConfigRequestEvidence.resolve(), flight)
  const bodies: string[] = []
  let call = 0
  const fakeFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      bodies.push(typeof init?.body === "string" ? init.body : "")
      return call++ === 1 ? brokenSse : successSse(80)
    },
    { preconnect: () => undefined },
  ) satisfies typeof fetch
  const languageModel = chatLanguageModel(observer, fakeFetch)
  const messages = (history: string): ModelMessage[] => [
    { role: "system", content: "private flight system" },
    { role: "user", content: history },
  ]

  const first = await drive(observer, languageModel, messages("first turn"))
  expect(first).toBeUndefined()
  flight.settle(Exit.succeed(undefined))

  const failed = await drive(observer, languageModel, [
    ...messages("first turn"),
    { role: "assistant", content: "ok" },
    { role: "user", content: "second turn" },
  ])
  expect(failed).toBeDefined()
  flight.settle(Exit.fail(failed as Error))

  const third = await drive(observer, languageModel, [
    ...messages("first turn"),
    { role: "assistant", content: "ok" },
    { role: "user", content: "second turn" },
  ])
  expect(third).toBeUndefined()
  flight.settle(Exit.succeed(undefined))

  expect(bodies).toHaveLength(3)
  const persisted = rows(sessionID)
  expect(persisted).toHaveLength(3)
  expect(new Set(persisted.map((row) => row.id)).size).toBe(3)
  for (const row of persisted) {
    expect(row.message_id).toBe(MessageID.make(messageID))
    expect(row.provider_id).toBe("openai")
    expect(row.model_id).toBe("gpt-5-mini")
    expect(row.time_created).toBeGreaterThan(0)
  }
  const data = persisted.map((row) => row.data)
  expect(data.map((value) => value.outcome).sort()).toEqual(["completed", "completed", "failed"])
  const success = data.filter((value) => value.outcome === "completed")
  for (const value of success) {
    expect(value).toMatchObject({
      input: 100,
      output: 10,
      cacheRead: 80,
      cacheMiss: 20,
      prefix: { system: expect.any(String), tools: expect.any(String), history: expect.any(String), compressed: false },
    })
    expect(value.durationMs).toBeGreaterThanOrEqual(0)
    expect(value.firstEventMs).toBeGreaterThanOrEqual(0)
  }
  // 失败尝试有自己的前缀变化与时间，但没有可实报的 usage；不能借用成功那两次的数字。
  const failedRow = data.find((value) => value.outcome === "failed")
  expect(failedRow).toMatchObject({ prefix: { history: "append" } })
  expect(failedRow).not.toHaveProperty("input")
  expect(failedRow).not.toHaveProperty("output")
  expect(failedRow).not.toHaveProperty("cacheRead")
  // 前缀按真实尝试推进：第一次基线，失败那次 append，第三次与失败同 body 是 unchanged。
  expect(success.map((value) => value.prefix?.history).sort()).toEqual(["baseline", "unchanged"])
  // 隐私哨兵只留在测试请求里，落库行（含 JSON 序列化）不得出现正文、头或账号。
  const persistedText = JSON.stringify(persisted)
  expect(persistedText).not.toContain("private flight system")
  expect(persistedText).not.toContain("first turn")
  expect(persistedText).not.toContain("test-key")
  const allowed = new Set([
    "outcome",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheMiss",
    "durationMs",
    "firstEventMs",
    "prefix",
    "diagnostics",
  ])
  for (const value of data) {
    for (const key of Object.keys(value)) expect(allowed.has(key)).toBe(true)
    expect(Object.keys(value.prefix ?? {}).sort()).toEqual(["compressed", "history", "system", "tools"])
  }
})

// 261126 Red 网络/HTTP 失败发生在 capture 之前：started 就要建行、rejected 按同 ID 结算失败；
// body 超限同样保留一行，只是没有 prefix 证据。重试是两次独立 started，不把事件结给前一次。
test("keeps a row for rejected doStream and body-too-large attempts", async () => {
  const sessionID = "ses_flight_start"
  const messageID = "msg_flight_start"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const limits = ConfigRequestEvidence.resolve({ maxBodyBytes: 1024 })
  const observer = RequestEvidence.create(context(sessionID), limits, flight)
  const middleware = RequestEvidence.middleware(observer)

  await expect(
    middleware.wrapStream({
      doStream: async () => {
        throw new Error("connect ECONNREFUSED")
      },
    }),
  ).rejects.toThrow("ECONNREFUSED")
  // rejected 钩子已经按同一关联号结算失败；这里的整流结算不应改变结果。
  flight.settle(Exit.fail(new Error("connect ECONNREFUSED")))

  const result = await middleware.wrapStream({
    doStream: async () => ({
      request: { body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] }) },
      stream: new ReadableStream<AdapterPart>({
        start(controller) {
          controller.close()
        },
      }),
    }),
  })
  await feed(observer, (result as { stream: ReadableStream<AdapterPart> }).stream)
  flight.settle(Exit.succeed(undefined))

  // 取消（AbortError）不是失败尝试：rejected 不落，最终按 interrupted 记 cancelled。
  await expect(
    middleware.wrapStream({
      doStream: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      },
    }),
  ).rejects.toThrow("aborted")
  flight.settle(interruptExit())

  const persisted = rows(sessionID)
  expect(persisted).toHaveLength(3)
  const rejected = persisted.find((row) => row.data.outcome === "failed")
  const oversized = persisted.find((row) => row.data.outcome === "unknown")
  const cancelled = persisted.find((row) => row.data.outcome === "cancelled")
  expect(rejected?.data).toMatchObject({ outcome: "failed" })
  expect(rejected?.data.prefix).toBeUndefined()
  expect(oversized?.data.prefix).toBeUndefined()
  expect(oversized?.data.diagnostics).toMatchObject({
    runtime: "ai-sdk",
    capture: { status: "unsupported", reason: "body-too-large" },
  })
  expect(cancelled?.data.prefix).toBeUndefined()
})

// 261126 Red 原始 vendor usage 按同 ID 归属：Chat/Anthropic 形状都给 reported totals；
// 缺失的缓存字段保持缺失、显式 0 保留；read > input 的矛盾样本 omit cacheMiss 但不改原值。
test("uses same-attempt raw provider usage and keeps missing distinct from zero", () => {
  const sessionID = "ses_flight_raw"
  const messageID = "msg_flight_raw"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const observer = RequestEvidence.create(context(sessionID), ConfigRequestEvidence.resolve(), flight)
  const row = (requestID: string) => rows(sessionID).find((item) => item.id === requestID)
  const done = () => flight.settle(Exit.succeed(undefined))

  const openaiChat = observe(observer, chatBody("openai chat"))
  observer.providerUsage?.({
    requestID: openaiChat.requestID,
    cachedTokens: "reported",
    fields: { prompt_tokens: 100, completion_tokens: 10, "prompt_tokens_details.cached_tokens": 80 },
  })
  done()
  expect(row(openaiChat.requestID)?.data).toMatchObject({ input: 100, output: 10, cacheRead: 80, cacheMiss: 20 })

  const anthropic = observe(observer, chatBody("anthropic"))
  observer.providerUsage?.({
    requestID: anthropic.requestID,
    cachedTokens: "reported",
    fields: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
  })
  done()
  expect(row(anthropic.requestID)?.data).toMatchObject({
    input: 100,
    output: 5,
    cacheRead: 80,
    cacheWrite: 0,
    cacheMiss: 20,
  })

  const missing = observe(observer, chatBody("missing cache"))
  observer.providerUsage?.({
    requestID: missing.requestID,
    cachedTokens: "missing",
    fields: { input_tokens: 100, output_tokens: 5 },
  })
  done()
  expect(row(missing.requestID)?.data).toMatchObject({ input: 100, output: 5 })
  expect(row(missing.requestID)?.data).not.toHaveProperty("cacheRead")
  expect(row(missing.requestID)?.data).not.toHaveProperty("cacheWrite")
  expect(row(missing.requestID)?.data).not.toHaveProperty("cacheMiss")

  const zero = observe(observer, chatBody("explicit zero"))
  observer.providerUsage?.({
    requestID: zero.requestID,
    cachedTokens: "reported-zero",
    fields: { input_tokens: 0, output_tokens: 0, "input_tokens_details.cached_tokens": 0 },
  })
  done()
  expect(row(zero.requestID)?.data).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheMiss: 0 })

  const contradictory = observe(observer, chatBody("cache over total"))
  observer.providerUsage?.({
    requestID: contradictory.requestID,
    cachedTokens: "reported",
    fields: { input_tokens: 10, output_tokens: 1, "input_tokens_details.cached_tokens": 50 },
  })
  done()
  expect(row(contradictory.requestID)?.data).toMatchObject({ input: 10, cacheRead: 50 })
  expect(row(contradictory.requestID)?.data).not.toHaveProperty("cacheMiss")
})

test("reads DeepSeek usage through the SDK and ties high, low and recovered hits to the observed baseline", async () => {
  const sessionID = "ses_flight_deepseek"
  const messageID = "msg_flight_deepseek"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const observer = RequestEvidence.create(context(sessionID), ConfigRequestEvidence.resolve(), flight)
  const samples = [
    { hit: 98, miss: 2, rate: 98 },
    { hit: 32, miss: 68, rate: 32 },
    { hit: 99, miss: 1, rate: 99 },
    { hit: 0, miss: 100, rate: 0 },
    { hit: 150, miss: 1, rate: undefined },
    { hit: 76, miss: 90, rate: undefined },
    { hit: -1, miss: 100, rate: undefined },
  ]
  let index = 0
  const sent: unknown[] = []
  const fetch = Object.assign(
    async (_: Parameters<typeof globalThis.fetch>[0], init: Parameters<typeof globalThis.fetch>[1]) => {
      sent.push(init?.body)
      const sample = samples[index++]!
      return successSse(undefined, { prompt_cache_hit_tokens: sample.hit, prompt_cache_miss_tokens: sample.miss })
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const languageModel = chatLanguageModel(observer, fetch)
  const seen = new Set<string>()
  let previous: string | undefined
  for (const sample of samples) {
    expect(await drive(observer, languageModel, [{ role: "user", content: "same flight body" }])).toBeUndefined()
    flight.settle(Exit.succeed(undefined))
    const current = rows(sessionID).find((item) => !seen.has(item.id))!
    expect(current.data.input).toBe(100)
    expect(current.data.cacheRead).toBe(sample.rate)
    expect(current.data.cacheWrite).toBeUndefined()
    if (sample.rate !== undefined) expect(current.data.cacheMiss).toBe(sample.miss)
    const capture = current.data.diagnostics?.capture
    expect(capture?.status).toBe("captured")
    expect(capture?.status === "captured" && capture.previousRequestID).toBe(previous)
    seen.add(current.id)
    previous = current.id
  }
  expect(new Set(sent).size).toBe(1)
})

test("does not turn missing Anthropic cache components into zero or a total", () => {
  const sessionID = "ses_flight_anthropic_missing"
  const messageID = "msg_flight_anthropic_missing"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID, "ai-sdk", true)
  const observer = RequestEvidence.create(context(sessionID), ConfigRequestEvidence.resolve(), flight)
  const attempt = observe(observer, chatBody())
  observer.providerUsage?.({
    requestID: attempt.requestID,
    cachedTokens: "missing",
    fields: { input_tokens: 15, output_tokens: 2 },
  })
  flight.settle(Exit.succeed(undefined))
  const data = rows(sessionID)[0]?.data
  expect(data?.output).toBe(2)
  expect(data?.input).toBeUndefined()
  expect(data?.cacheRead).toBeUndefined()
  expect(data?.cacheWrite).toBeUndefined()
})

test("projects only bounded prefix evidence and skips unsupported bodies in the baseline chain", () => {
  const sessionID = "ses_flight_diagnostics"
  const messageID = "msg_flight_diagnostics"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const observer = RequestEvidence.create(context(sessionID), ConfigRequestEvidence.resolve(), flight)
  const body = { ...chatBody(), prompt_cache_key: "private-affinity" }
  const first = observe(observer, body)
  const failed = RequestEvidence.withRequest(observer, () => observer.capture("{bad JSON"))
  const reordered = observe(observer, {
    ...body,
    messages: [...body.messages].reverse(),
    prompt_cache_key: "new-private-affinity",
  })
  const appended = observe(observer, { ...body, messages: [...body.messages, { role: "user", content: "added" }] })
  const rewritten = observe(observer, chatBody("changed original"))
  flight.settle(Exit.succeed(undefined))
  const all = rows(sessionID)
  const capture = (id: string) => all.find((row) => row.id === id)?.data.diagnostics?.capture
  expect(capture(failed.requestID)).toEqual({ status: "unsupported", reason: "invalid-json" })
  expect(capture(reordered.requestID)).toMatchObject({
    status: "captured",
    previousRequestID: first.requestID,
    wire: "changed",
    serialized: "changed",
    parameters: "rewrite",
    affinity: "changed",
    system: { change: "unchanged", countDelta: 0, bytesDelta: 0 },
    history: { change: "unchanged" },
  })
  expect(capture(appended.requestID)).toMatchObject({
    previousRequestID: reordered.requestID,
    history: { change: "append", count: 2, countDelta: 1, bytesDelta: expect.any(Number), firstDifference: 1 },
  })
  expect(capture(rewritten.requestID)).toMatchObject({
    history: { change: "rewrite", countDelta: -1, firstDifference: 0 },
  })
  expect(JSON.stringify(all)).not.toMatch(/private-affinity|private flight system|sha256/)
  RequestEvidence.reset()
  expect(observe(observer, body)).toMatchObject({ previousRequestID: undefined, affinityChange: "baseline" })
  flight.settle(Exit.succeed(undefined))
})

// 261126 Red 取消尝试按 interrupted exit 记 cancelled，且不写入任何未实报 usage。
test("records cancellation without borrowing usage from another attempt", () => {
  const sessionID = "ses_flight_cancel"
  const messageID = "msg_flight_cancel"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const observer = RequestEvidence.create(context(sessionID), ConfigRequestEvidence.resolve(), flight)
  observe(observer, chatBody())
  observer.event(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { outputTokens: 9 } }))
  flight.settle(interruptExit())

  const [row] = rows(sessionID)
  expect(row?.data).toMatchObject({ outcome: "cancelled", prefix: { history: "baseline" } })
  expect(row?.data).not.toHaveProperty("input")
  expect(row?.data).not.toHaveProperty("output")
})

// 261126 Red 压缩标记：同桶前次标记可比且本次更新才算；首次基线、无标记、不同模型桶都不猜；
// DCP 回执走既有 afterCompression 通道。
test("flags compression only when a comparable same-bucket marker advanced", () => {
  const sessionID = "ses_flight_compaction"
  const messageID = "msg_flight_compaction"
  seed(sessionID, messageID)
  const flight = flightFor(sessionID, messageID)
  const observer = RequestEvidence.create(
    { ...context(sessionID), lastCompactionAt: 100 },
    ConfigRequestEvidence.resolve(),
    flight,
  )
  expect(observe(observer, chatBody("one")).compacted).toBeUndefined()
  expect(observer.capture(chatBody("two"))).toMatchObject({ status: "captured" })
  const compressedNext = RequestEvidence.create(
    { ...context(sessionID), lastCompactionAt: 200 },
    ConfigRequestEvidence.resolve(),
    flight,
  )
  expect(observe(compressedNext, chatBody("three")).compacted).toBe(true)
  // 同一标记重复出现不重复报新压缩。
  expect(observe(compressedNext, chatBody("four")).compacted).toBeUndefined()

  // 不同模型桶的标记不串：第一次观察只有基线，不猜压缩。
  const other = RequestEvidence.create(
    { ...context(sessionID, "openai/other-model"), lastCompactionAt: 300 },
    ConfigRequestEvidence.resolve(),
    flight,
  )
  expect(observe(other, chatBody("other")).compacted).toBeUndefined()

  // DCP 回执仍走 afterCompression，下一个请求的 prefix.compressed 为 true。
  const dcp = RequestEvidence.create(
    { ...context(sessionID, "openai/dcp-model") },
    ConfigRequestEvidence.resolve(),
    flight,
  )
  observe(dcp, chatBody("dcp one"))
  dcp.event(
    LLMEvent.toolResult({
      id: "compress-flight",
      name: "compress",
      result: ToolResultValue.make({
        metadata: {
          dcpCompression: {
            version: 1,
            runId: 1,
            blockCount: 1,
            inputTokensEstimated: 10,
            summaryTokensEstimated: 2,
            netSavingsEstimated: 8,
          },
        },
      }),
    }),
  )
  const compressed = observe(dcp, chatBody("dcp two"))
  expect(compressed.afterCompression).toHaveLength(1)
  flight.settle(Exit.succeed(undefined))
  expect(rows(sessionID).find((row) => row.id === compressed.requestID)?.data).toMatchObject({
    prefix: { compressed: true },
    diagnostics: {
      capture: {
        compression: {
          receipts: 1,
          blockCount: 1,
          inputTokensEstimated: 10,
          summaryTokensEstimated: 2,
          netSavingsEstimated: 8,
        },
      },
    },
  })
})

// 261126 Red 截断：每会话只保留最近 128 行；时间由 started 固定，验证删的是旧行。
test("keeps the newest 128 rows per session and never resurrects pruned rows", () => {
  const sessionID = "ses_flight_prune"
  const messageID = "msg_flight_prune"
  seed(sessionID, messageID)
  const older = flightFor(sessionID, messageID)
  older.started("req_flight_0000", 1000)
  expect(rows(sessionID)[0]?.id).toBe("req_flight_0000")
  const flight = flightFor(sessionID, messageID)
  const observation = (requestID: string): Captured => ({
    status: "captured",
    requestID,
    system: { sha256: "system", count: 0, length: 0, change: "baseline" },
    tools: { sha256: "tools", count: 0, length: 0, change: "baseline" },
    history: { sha256: "history", count: 0, length: 0, change: "append" },
    parameters: { sha256: "parameters", count: 0, length: 0, change: "unchanged" },
    serialized: { sha256: "serialized", length: 1, change: "changed" },
    affinity: {},
    affinityChange: "baseline",
    wire: { sha256: "wire", length: 1, change: "changed" },
    afterCompression: [],
  })
  for (let index = 1; index < FlightRecording.KEEP_PER_SESSION + 12; index++) {
    const requestID = `req_flight_${String(index).padStart(4, "0")}`
    flight.started(requestID, 1000 + index)
    flight.capture(observation(requestID))
  }
  flight.settle(Exit.succeed(undefined))
  expect(rows(sessionID).map((row) => row.id)).not.toContain("req_flight_0000")
  older.providerUsage({ requestID: "req_flight_0000", cachedTokens: "missing", fields: {} })
  older.settle(Exit.succeed(undefined))

  const persisted = rows(sessionID)
  expect(persisted).toHaveLength(FlightRecording.KEEP_PER_SESSION)
  expect(persisted.map((row) => row.id)).not.toContain("req_flight_0000")
  expect(persisted.map((row) => row.id)).toContain("req_flight_0012")
  expect(persisted.map((row) => row.id)).toContain("req_flight_0139")
})

test("coalesces short attempts and skips a deleted parent without losing its batch neighbours", () => {
  const sessionID = "ses_flight_batch"
  const messageID = "msg_flight_batch"
  const deleted = "msg_flight_batch_deleted"
  seed(sessionID, messageID)
  seed(sessionID, deleted)
  const db = Database.Client().$client
  const survivor = flightFor(sessionID, messageID)
  const lost = flightFor(sessionID, deleted)
  const before = Writer.stats()
  lost.started("req_deleted", 10)
  survivor.started("req_survivor", 20)
  survivor.providerUsage({ requestID: "req_survivor", cachedTokens: "missing", fields: {} })
  survivor.settle(Exit.succeed(undefined))
  expect(Writer.stats().pending - before.pending).toBe(2)
  expect(db.query("SELECT count(*) AS n FROM flight_request WHERE session_id = ?").get(sessionID)).toEqual({ n: 0 })
  db.run("DELETE FROM message WHERE id = ?", [deleted])
  lost.settle(Exit.succeed(undefined))
  expect(rows(sessionID)).toMatchObject([{ id: "req_survivor", data: { outcome: "completed" } }])
  expect(Writer.stats().batches - before.batches).toBe(1)
})

test("settles already written attempts in a batch using the usage from each request", () => {
  const sessionID = "ses_flight_late_batch"
  const messageID = "msg_flight_late_batch"
  seed(sessionID, messageID)
  const a = flightFor(sessionID, messageID)
  const b = flightFor(sessionID, messageID)
  a.started("req_late_a", 1)
  b.started("req_late_b", 2)
  expect(rows(sessionID).map(({ data }) => data.outcome)).toEqual(["unknown", "unknown"])
  a.providerUsage({ requestID: "req_late_a", cachedTokens: "reported-zero", fields: {
    input_tokens: 100, "input_tokens_details.cached_tokens": 0,
  } })
  b.providerUsage({ requestID: "req_late_b", cachedTokens: "reported", fields: {
    input_tokens: 100, "input_tokens_details.cached_tokens": 85,
  } })
  a.settle(Exit.succeed(undefined))
  b.settle(Exit.succeed(undefined))
  const before = Writer.stats().batches
  expect(rows(sessionID)).toMatchObject([
    { id: "req_late_a", data: { outcome: "completed", cacheRead: 0 } },
    { id: "req_late_b", data: { outcome: "completed", cacheRead: 85 } },
  ])
  expect(Writer.stats().batches - before).toBe(1)
})

test("bounds queued writes and reports SQLite write failure without carrying it into the next attempt", () => {
  const sessionID = "ses_flight_write_failure"
  const messageID = "msg_flight_write_failure"
  seed(sessionID, messageID)
  const db = Database.Client().$client
  const flight = flightFor(sessionID, messageID)
  const before = Writer.stats().dropped
  db.run("PRAGMA query_only = ON")
  try {
    for (let index = 0; index < Writer.MAX_PENDING + 1; index++) {
      flight.started(`req_readonly_${index}`, index)
      flight.settle(Exit.succeed(undefined))
    }
    expect(Writer.stats()).toMatchObject({ pending: Writer.MAX_PENDING, dropped: before + 1 })
    expect(rows(sessionID)).toEqual([])
    expect(Writer.stats().dropped - before).toBe(Writer.MAX_PENDING + 1)
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
  } finally {
    db.run("PRAGMA query_only = OFF")
  }
  flight.started("req_recovered", 999)
  flight.settle(Exit.succeed(undefined))
  expect(rows(sessionID)).toMatchObject([{ id: "req_recovered" }])
})

// 261126 Red 同一进程两个会话/消息的关联号与桶互不串。
test("isolates request IDs and prefix baselines across sessions", () => {
  seed("ses_flight_iso_a", "msg_flight_iso_a")
  seed("ses_flight_iso_b", "msg_flight_iso_b")
  const a = flightFor("ses_flight_iso_a", "msg_flight_iso_a")
  const b = flightFor("ses_flight_iso_b", "msg_flight_iso_b")
  const observerA = RequestEvidence.create(context("ses_flight_iso_a"), ConfigRequestEvidence.resolve(), a)
  const observerB = RequestEvidence.create(context("ses_flight_iso_b"), ConfigRequestEvidence.resolve(), b)
  observe(observerA, chatBody())
  observe(observerB, chatBody("other"))
  a.settle(Exit.succeed(undefined))
  b.settle(Exit.succeed(undefined))

  const first = rows("ses_flight_iso_a")
  const second = rows("ses_flight_iso_b")
  expect(first).toHaveLength(1)
  expect(second).toHaveLength(1)
  expect(first[0]?.id).not.toBe(second[0]?.id)
  expect(first[0]?.message_id).toBe(MessageID.make("msg_flight_iso_a"))
  expect(second[0]?.message_id).toBe(MessageID.make("msg_flight_iso_b"))
  expect(first[0]?.data.prefix?.history).toBe("baseline")
  expect(second[0]?.data.prefix?.history).toBe("baseline")
})

// 261126 Red native 真实出站 body + 真实 SSE 协议：一行完成，实报 usage 与首事件时间来自 native 流。
it.effect("records a native attempt from the actual wire body and protocol events", () =>
  Effect.gen(function* () {
    const sessionID = "ses_flight_native"
    const messageID = "msg_flight_native"
    seed(sessionID, messageID)
    const flight = flightFor(sessionID, messageID, "native")
    const observer = RequestEvidence.create(
      context(sessionID, `${model.providerID}/${model.id}`, "native"),
      ConfigRequestEvidence.resolve(),
      flight,
    )
    const customFetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], _init: Parameters<typeof fetch>[1]) =>
        new Response(
          [
            `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_native", delta: "ok" })}`,
            "",
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  input_tokens_details: { cached_tokens: 80 },
                  attribution: {
                    request_fields: { instructions: { input_tokens: 10, cached_tokens: 0, cache_write_tokens: 0 } },
                  },
                },
              },
            })}`,
            "",
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      { preconnect: () => undefined },
    ) satisfies typeof fetch
    const llmClient = yield* LLMClient.Service
    const native = LLMNativeRuntime.stream({
      model,
      provider: { ...provider, options: { apiKey: OAUTH_DUMMY_KEY, fetch: customFetch } },
      auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
      llmClient,
      messages: [
        { role: "system", content: "private native system" },
        { role: "user", content: "hello" },
      ],
      tools: {},
      headers: {},
      abort: new AbortController().signal,
      requestEvidence: observer,
      observeRequest: observer.capture,
    })
    expect(native.type).toBe("supported")
    if (native.type === "unsupported") return
    const events = yield* native.stream.pipe(
      Stream.tap((event) => Effect.sync(() => observer.event(event))),
      Stream.onExit((exit) => Effect.sync(() => flight.settle(exit))),
      Stream.runCollect,
    )
    expect(Array.from(events).some((event) => event.type === "finish")).toBe(true)

    const [row] = rows(sessionID)
    expect(row).toMatchObject({ message_id: MessageID.make(messageID), provider_id: "openai", model_id: "gpt-5-mini" })
    expect(row?.data).toMatchObject({
      outcome: "completed",
      input: 100,
      output: 10,
      cacheRead: 80,
      cacheMiss: 20,
      prefix: { system: "baseline", tools: "baseline", history: "baseline", compressed: false },
      diagnostics: {
        runtime: "native",
        instructions: { source: "provider", inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, missTokens: 10 },
        unattributedInputTokens: 10,
      },
    })
    expect(row?.data.durationMs).toBeGreaterThanOrEqual(0)
    expect(row?.data.firstEventMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(row)).not.toContain("private native system")
  }),
)
