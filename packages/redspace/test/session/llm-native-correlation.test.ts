import { describe, expect } from "bun:test"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@redcode-ai/llm/route"
import type { LLMEvent } from "@redcode-ai/llm"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import type { ModelMessage, Tool } from "ai"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { RequestEvidence } from "@/session/request-evidence"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { testEffect } from "../lib/effect"

const baseModel: Provider.Model = {
  id: ModelID.make("gpt-5-mini"),
  providerID: ProviderID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
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

// Chat protocol route: forces the onHalt finish path (the body ends without [DONE]).
const chatModel: Provider.Model = {
  ...baseModel,
  id: ModelID.make("deepseek-reasoner"),
  name: "DeepSeek Reasoner",
  api: {
    id: "deepseek-reasoner",
    url: "https://api.deepseek.test/v1",
    npm: "@ai-sdk/openai-compatible",
  },
}

const providerInfo: Provider.Info = {
  id: ProviderID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: OAUTH_DUMMY_KEY, baseURL: "https://api.deepseek.test/v1" },
  models: {},
}

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
)

type FetchArgs = Parameters<typeof fetch>
type Capture = { readonly body?: Uint8Array; readonly headers?: unknown }

const capture = (init: FetchArgs[1]): Capture => ({
  body: init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined,
  headers: init?.headers,
})

const sse = (...chunks: ReadonlyArray<unknown>) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const responsesStream = (text: string) =>
  sse(
    { type: "response.output_text.delta", item_id: "msg_1", delta: text },
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
  )

const chatChunk = (delta: object, finishReason: string | null = null) => ({
  id: "chatcmpl_fixture",
  choices: [{ delta, finish_reason: finishReason }],
  usage: null,
})

// Chat EOF: the last chunk carries finish_reason and usage, then the body ends
// without a `[DONE]` sentinel; the protocol flushes step-finish via onHalt.
const chatStream = () =>
  sse(chatChunk({ role: "assistant", content: "Hello" }), chatChunk({}, "stop"), {
    id: "chatcmpl_fixture",
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  })

// Same Responses chunks as `responsesStream`, but the completed/usage frame is
// withheld until the gate opens so a second subscription can finish first.
const gatedResponsesStream = (text: string, gate: Promise<void>) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: text })}\n\n`,
          ),
        )
        gate.then(() => {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`,
            ),
          )
          controller.close()
        })
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

const fetchOf = (handler: (input: FetchArgs[0], init: FetchArgs[1]) => Promise<Response>) =>
  Object.assign(handler, { preconnect: () => undefined }) satisfies typeof fetch

type InputArgs = {
  readonly model: Provider.Model
  readonly fetch: typeof globalThis.fetch
  readonly requestEvidence?: RequestEvidence.Observer
  readonly messages?: ModelMessage[]
}

const streamOf = Effect.fnUntraced(function* (args: InputArgs) {
  const llmClient = yield* LLMClient.Service
  const native = LLMNativeRuntime.stream({
    model: args.model,
    provider: { ...providerInfo, options: { ...providerInfo.options, fetch: args.fetch } },
    auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
    llmClient,
    messages: args.messages ?? ([{ role: "user", content: "hello" }] as ModelMessage[]),
    tools: {} as Record<string, Tool>,
    headers: {},
    abort: new AbortController().signal,
    requestEvidence: args.requestEvidence,
  })
  if (native.type !== "supported") return yield* Effect.die(new Error(native.reason))
  return native.stream
})

const observer = (ids: string[]) =>
  RequestEvidence.create({ sessionID: "session", modelKey: "openai/gpt-5-mini", runtime: "native" }, undefined, {
    started: (requestID) => ids.push(requestID),
  })

const stepFinish = (events: ReadonlyArray<LLMEvent>) => {
  const event = events.find((item) => item.type === "step-finish")
  return event?.type === "step-finish" ? event : undefined
}

describe("native request correlation", () => {
  it.live("keeps the wire request byte-identical with and without evidence", () =>
    Effect.gen(function* () {
      const captures: Capture[] = []
      const ids: string[] = []
      const fetch = fetchOf(async (input: FetchArgs[0], init: FetchArgs[1]) => {
        captures.push(capture(init))
        return responsesStream("Hello")
      })

      yield* (yield* streamOf({ model: baseModel, fetch, requestEvidence: observer(ids) })).pipe(Stream.runDrain)
      yield* (yield* streamOf({ model: baseModel, fetch })).pipe(Stream.runDrain)

      expect(captures).toHaveLength(2)
      expect(Buffer.from(captures[0].body!).equals(Buffer.from(captures[1].body!))).toBe(true)
      // Trace propagation ids differ per execution; every other header must match.
      const stable = (item: Capture) =>
        Object.fromEntries(
          Object.entries(item.headers as Record<string, string>).filter(
            ([key]) => key !== "b3" && key !== "traceparent",
          ),
        )
      expect(stable(captures[0])).toEqual(stable(captures[1]))

      const body = new TextDecoder().decode(captures[0].body!)
      expect(body).not.toContain(ids[0])
      expect(JSON.stringify(captures[0].headers)).not.toContain(ids[0])
    }),
  )

  it.live("links the native step-finish to the generated request id and leaves plain runs unlinked", () =>
    Effect.gen(function* () {
      const ids: string[] = []
      const fetch = fetchOf(async () => responsesStream("Hello"))

      const correlated = Array.from(
        yield* (yield* streamOf({ model: baseModel, fetch, requestEvidence: observer(ids) })).pipe(Stream.runCollect),
      )
      const plain = Array.from(yield* (yield* streamOf({ model: baseModel, fetch })).pipe(Stream.runCollect))

      expect(ids).toHaveLength(1)
      expect(stepFinish(correlated)?.requestID).toBe(ids[0])
      expect(stepFinish(plain)).toMatchObject({ type: "step-finish" })
      expect(stepFinish(plain)?.requestID).toBeUndefined()
    }),
  )

  it.live("associates only the successful attempt after a 503 retry", () =>
    Effect.gen(function* () {
      const ids: string[] = []
      let attempts = 0
      const fetch = fetchOf(async () => {
        attempts++
        if (attempts === 1) return new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
        return responsesStream("Hello")
      })

      const events = Array.from(
        yield* (yield* streamOf({ model: baseModel, fetch, requestEvidence: observer(ids) })).pipe(Stream.runCollect),
      )

      expect(attempts).toBe(2)
      expect(ids).toHaveLength(2)
      expect(ids[0]).not.toBe(ids[1])
      expect(stepFinish(events)?.requestID).toBe(ids[1])
    }),
  )

  it.live("keeps interleaved streams on their own ids", () =>
    Effect.gen(function* () {
      let arrived = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const fetch = fetchOf(async () => {
        const index = arrived++
        if (index === 1) release()
        if (index === 0) await gate
        return responsesStream(`reply-${index}`)
      })

      const idsA: string[] = []
      const idsB: string[] = []
      const [a, b] = yield* Effect.all(
        [
          (yield* streamOf({
            model: baseModel,
            fetch,
            requestEvidence: observer(idsA),
            messages: [{ role: "user", content: "A" }],
          })).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
          (yield* streamOf({
            model: baseModel,
            fetch,
            requestEvidence: observer(idsB),
            messages: [{ role: "user", content: "B" }],
          })).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ],
        { concurrency: 2 },
      )

      expect(arrived).toBe(2)
      expect(idsA).toHaveLength(1)
      expect(idsB).toHaveLength(1)
      expect(idsA[0]).not.toBe(idsB[0])
      expect(stepFinish(a)?.requestID).toBe(idsA[0])
      expect(stepFinish(b)?.requestID).toBe(idsB[0])
    }),
  )

  it.live("does not book a linked step when the stream is cancelled before finishing", () =>
    Effect.gen(function* () {
      const ids: string[] = []
      const fetch = fetchOf(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: "partial" })}\n\n`,
                  ),
                )
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      )

      const events = Array.from(
        yield* (yield* streamOf({ model: baseModel, fetch, requestEvidence: observer(ids) })).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      )

      expect(ids).toHaveLength(1)
      expect(events).toHaveLength(1)
      expect(stepFinish(events)).toBeUndefined()
    }),
  )

  it.live("carries the id through the Chat EOF onHalt finish", () =>
    Effect.gen(function* () {
      const ids: string[] = []
      const fetch = fetchOf(async () => chatStream())

      const events = Array.from(
        yield* (yield* streamOf({ model: chatModel, fetch, requestEvidence: observer(ids) })).pipe(Stream.runCollect),
      )

      expect(ids).toHaveLength(1)
      expect(stepFinish(events)?.requestID).toBe(ids[0])
    }),
  )

  it.live("honors FetchHttpClient.RequestInit and merges request headers over init headers", () =>
    Effect.gen(function* () {
      const ids: string[] = []
      const captures: Array<RequestInit | undefined> = []
      const fetch = fetchOf(async (_input, init) => {
        captures.push(init as RequestInit | undefined)
        return responsesStream("Hello")
      })

      const options = {
        headers: {
          authorization: "init-auth",
          "x-request-init": "init-value",
          "content-type": "text/plain",
        },
        redirect: "manual",
        credentials: "include",
        cache: "no-store",
        // Per-request values must win over the ambient options.
        method: "GET",
        body: "init-body-should-not-be-sent",
      } satisfies RequestInit

      const events = Array.from(
        yield* (yield* streamOf({ model: baseModel, fetch, requestEvidence: observer(ids) })).pipe(
          Stream.provideService(FetchHttpClient.RequestInit, options),
          Stream.runCollect,
        ),
      )

      expect(captures).toHaveLength(1)
      const init = captures[0]!
      // Other RequestInit fields are spread through before the per-request overrides.
      expect(init.redirect).toBe("manual")
      expect(init.credentials).toBe("include")
      expect(init.cache).toBe("no-store")
      expect(init.method).toBe("POST")
      expect(init.body).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(init.body as Uint8Array)).toContain('"model":"gpt-5-mini"')
      const headers = init.headers as Record<string, string>
      expect(headers["x-request-init"]).toBe("init-value")
      // Request headers win over init headers, exactly like FetchHttpClient.
      expect(headers["content-type"]).toBe("application/json")
      expect(headers["authorization"]).toBe(`Bearer ${OAUTH_DUMMY_KEY}`)
      // The per-attempt id is unchanged by the extra options.
      expect(stepFinish(events)?.requestID).toBe(ids[0])
    }),
  )

  // 261126 Red Effect Streams may be subscribed more than once. Consume one
  // shared native stream twice concurrently: the first subscription's response
  // is deliberately held open while the second finishes, which is exactly the
  // window where a shared `requestID`/shared request-object overwrite would
  // cross the two bills.
  it.live("keeps concurrent subscriptions of one shared native stream on their own ids", () =>
    Effect.gen(function* () {
      const ids: string[] = []
      const fetchIds: string[] = []
      let calls = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const fetch = fetchOf(async () => {
        const index = calls++
        // withRequest calls `started` synchronously right before this fetch, so
        // the last recorded id belongs to this attempt.
        fetchIds[index] = ids.at(-1)!
        if (index === 0) return gatedResponsesStream("slow", gate)
        return responsesStream("fast")
      })

      const stream = yield* streamOf({ model: baseModel, fetch, requestEvidence: observer(ids) })
      const collect = stream.pipe(
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
        Effect.tap((events) =>
          Effect.sync(() => {
            if (events.some((event) => event.type === "text-delta" && event.text === "fast")) release()
          }),
        ),
      )

      const [a, b] = yield* Effect.all([collect, collect], { concurrency: 2 })
      const text = (events: ReadonlyArray<LLMEvent>) =>
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join("")
      const fast = text(a) === "fast" ? a : b
      const slow = fast === a ? b : a

      expect(calls).toBe(2)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      expect(text(fast)).toBe("fast")
      expect(text(slow)).toBe("slow")
      expect(stepFinish(fast)?.requestID).toBe(fetchIds[1])
      expect(stepFinish(slow)?.requestID).toBe(fetchIds[0])
    }),
  )
})
