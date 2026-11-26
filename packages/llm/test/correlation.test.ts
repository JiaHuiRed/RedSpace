import { describe, expect } from "bun:test"
import { Effect, Layer, Ref, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { LLM } from "../src"
import { LLMClient, correlateRequest } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { deltaChunk, finishChunk, usageChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"
import { runtimeLayer } from "./lib/http"
import { it } from "./lib/effect"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
  .model({ id: "gpt-4o-mini" })

const sse = (...chunks: ReadonlyArray<unknown>) =>
  new Response(sseEvents(...chunks), { status: 200, headers: { "content-type": "text/event-stream" } })

const chat = (usage: Record<string, number> = {}) =>
  sse(deltaChunk({ role: "assistant", content: "Hello" }), finishChunk("stop"), usageChunk(usage))

const chatText = (text: string) =>
  sse(deltaChunk({ role: "assistant", content: text }), finishChunk("stop"), usageChunk({ prompt_tokens: 3, completion_tokens: 1 }))

// The first frame is delivered immediately; finish/usage wait for the gate so a
// second subscription can complete first.
const gatedChat = (text: string, gate: Promise<void>) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(deltaChunk({ role: "assistant", content: text }))}\n\n`),
        )
        gate.then(() => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk("stop"))}\n\n`))
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(usageChunk({ prompt_tokens: 3, completion_tokens: 1 }))}\n\n`,
            ),
          )
          controller.close()
        })
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

// 261126 Red Test transport that mirrors the native runtime: after acquiring a
// response, it attaches the caller-owned id to the exact request object. The
// ids rotate per attempt so a 503 retry can prove which attempt wins.
const correlatedLayer = (input: { readonly responses: ReadonlyArray<Response>; readonly ids: ReadonlyArray<string> }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cursor = yield* Ref.make(0)
      return runtimeLayer(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
              const id = input.ids[Math.min(index, input.ids.length - 1)]
              if (id !== undefined) correlateRequest(request, id)
              return HttpClientResponse.fromWeb(request, input.responses[Math.min(index, input.responses.length - 1)])
            }),
          ),
        ),
      )
    }),
  )

type EventLike = { readonly type: string; readonly requestID?: string; readonly reason?: string; readonly text?: string }
const events = (collected: ReadonlyArray<unknown>) => collected as ReadonlyArray<EventLike>
const stepFinish = (collected: ReadonlyArray<unknown>) =>
  events(collected).find((event) => event.type === "step-finish")
const requestIDOf = (collected: ReadonlyArray<unknown>, type: string) =>
  events(collected).find((event) => event.type === type)?.requestID

describe("RequestCorrelation", () => {
  it.effect("attaches the correlated id to the step-finish produced at Chat EOF", () =>
    Effect.gen(function* () {
      const collected = Array.from(
        yield* LLMClient.stream({ request: LLM.request({ model, prompt: "Hello" }), tools: {} }).pipe(
          Stream.runCollect,
        ),
      )

      expect(stepFinish(collected)?.requestID).toBe("attempt-1")
      // The aggregate finish is not a booked step; it must stay unlinked.
      expect(requestIDOf(collected, "finish")).toBeUndefined()
    }).pipe(
      Effect.provide(
        correlatedLayer({ responses: [chat({ prompt_tokens: 5, completion_tokens: 2 })], ids: ["attempt-1"] }),
      ),
    ),
  )

  it.live("links only the successful 503 retry attempt", () =>
    Effect.gen(function* () {
      const collected = Array.from(
        yield* LLMClient.stream({ request: LLM.request({ model, prompt: "Hello" }), tools: {} }).pipe(
          Stream.runCollect,
        ),
      )

      // A single attempt would surface the 503 as a stream failure and carry
      // attempt-1; the successful retry is the only one that reaches a step.
      expect(stepFinish(collected)?.requestID).toBe("attempt-2")
    }).pipe(
      Effect.provide(
        correlatedLayer({
          responses: [
            new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
            chat({ prompt_tokens: 5, completion_tokens: 2 }),
          ],
          ids: ["attempt-1", "attempt-2"],
        }),
      ),
    ),
  )

  it.effect("leaves a synthesized estimated finish unlinked even when the response was correlated", () =>
    Effect.gen(function* () {
      const collected = Array.from(
        yield* LLMClient.stream({ request: LLM.request({ model, prompt: "Hello" }), tools: {} }).pipe(
          Stream.catchCause(() => Stream.empty),
          Stream.runCollect,
        ),
      )

      const estimated = stepFinish(collected)
      expect(estimated?.reason).toBe("unknown")
      expect(estimated?.requestID).toBeUndefined()
    }).pipe(
      Effect.provide(
        correlatedLayer({
          responses: [
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "partial" }))}\n\n`,
                    ),
                  )
                },
                // The first frame is delivered, then the connection dies before
                // the provider finish/usage chunk.
                pull(controller) {
                  controller.error(new Error("connection reset"))
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
          ],
          ids: ["attempt-1"],
        }),
      ),
    ),
  )

  it.effect("leaves step-finish unlinked when the transport reports no correlation", () =>
    Effect.gen(function* () {
      const collected = Array.from(
        yield* LLMClient.stream({ request: LLM.request({ model, prompt: "Hello" }), tools: {} }).pipe(
          Stream.runCollect,
        ),
      )

      expect(stepFinish(collected)).toMatchObject({ type: "step-finish" })
      expect(stepFinish(collected)?.requestID).toBeUndefined()
    }).pipe(
      Effect.provide(
        correlatedLayer({
          responses: [chat({ prompt_tokens: 5, completion_tokens: 2 })],
          // Empty ids models a transport that cannot correlate (e.g. WebSocket).
          ids: [],
        }),
      ),
    ),
  )

  // 261126 Red Effect Streams can be subscribed more than once. `streamPrepared`
  // must bind the correlation to each subscription, not to a shared closure or a
  // shared prepared request object. The first subscription's response is held
  // open while the second one finishes so a cross-association would be visible.
  it.live("keeps concurrent subscriptions of one prepared stream on their own ids", () =>
    Effect.gen(function* () {
      let calls = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const runtime = {
        http: {
          execute: (request: HttpClientRequest.HttpClientRequest) =>
            Effect.gen(function* () {
              const index = calls++
              correlateRequest(request, `attempt-${index}`)
              return HttpClientResponse.fromWeb(
                request,
                index === 0 ? gatedChat("slow", gate) : chatText("fast"),
              )
            }),
        },
      }

      const route = OpenAIChat.route.with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
      const request = LLM.request({ model: route.model({ id: "gpt-4o-mini" }), prompt: "Hello" })
      const prepared = yield* route.prepareTransport(yield* route.body.from(request), request)
      const stream = route.streamPrepared(prepared, request, runtime)

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
      const text = (events: ReadonlyArray<EventLike>) =>
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text ?? "")
          .join("")
      const fast = text(a) === "fast" ? a : b
      const slow = fast === a ? b : a

      expect(calls).toBe(2)
      expect(stepFinish(fast)?.requestID).toBe("attempt-1")
      expect(stepFinish(slow)?.requestID).toBe("attempt-0")
    }),
  )
})
