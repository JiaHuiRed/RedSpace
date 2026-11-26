import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LLMEvent } from "@redcode-ai/llm"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { streamText, wrapLanguageModel, type LanguageModelMiddleware, type ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { RequestEvidence } from "@/session/request-evidence"

// 261126 Red FR-06：默认 AI SDK 路径的请求关联必须走真实 SDK 接缝验证——
// middleware wrapStream 返回的 response.headers 对象是否原样到达 finish-step，
// 以及中途被克隆/缺失时是否保持未关联。测试用真实 ai@7 + openai-compatible
// provider，只在 fetch 边界替换成脚本化 SSE。

type AdapterPart = Parameters<typeof LLMAISDK.toLLMEvents>[1]
type Observer = ReturnType<typeof RequestEvidence.create>
type FetchInit = Parameters<typeof fetch>[1]

const chatChunk = (delta: object, finishReason: string | null = null) => ({
  id: "chatcmpl_fixture",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  usage: null,
})

const sse = (chunks: ReadonlyArray<unknown>, headers: Record<string, string> = {}) =>
  new Response(
    [
      ...chunks.flatMap((chunk) => [`data: ${JSON.stringify(chunk)}`, ""]),
      "data: [DONE]",
      "",
    ].join("\n"),
    { headers: { "content-type": "text/event-stream", ...headers } },
  )

const textStream = (text: string, finishReason = "stop", headers: Record<string, string> = {}) =>
  sse(
    [
      chatChunk({ role: "assistant", content: text }),
      chatChunk({}, finishReason),
      { id: "chatcmpl_fixture", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ],
    headers,
  )

const fetchOf =
  (handler: (input: Parameters<typeof fetch>[0], init: FetchInit) => Promise<Response>) =>
  Object.assign(handler, { preconnect: () => undefined }) satisfies typeof fetch

const requestHeaders = (init: FetchInit) => Object.fromEntries(new Headers(init?.headers).entries())
const responseHeaders = (response: Response) => Object.fromEntries(response.headers.entries())

const observer = (ids: string[]) =>
  RequestEvidence.create(
    { sessionID: "ses_ai_sdk_correlation", modelKey: "fixture/fixture-model", runtime: "ai-sdk" },
    undefined,
    { started: (requestID) => ids.push(requestID) },
  )

const modelWith = (fetch: typeof globalThis.fetch, middleware: LanguageModelMiddleware[]) => {
  const compatible = createOpenAICompatible({
    name: "ai-sdk-correlation-test",
    baseURL: "https://correlation.test/v1",
    apiKey: "test-key",
    fetch,
  })
  return wrapLanguageModel({ model: compatible.chatModel("fixture-model"), middleware })
}

const evidenceModel = (observer: Observer, fetch: typeof globalThis.fetch, extra: {
  outer?: LanguageModelMiddleware[]
  inner?: LanguageModelMiddleware[]
} = {}) =>
  modelWith(fetch, [...(extra.outer ?? []), RequestEvidence.middleware(observer), ...(extra.inner ?? [])])

type Driven = {
  events: LLMEvent[]
  parts: AdapterPart[]
  response: Awaited<ReturnType<typeof streamText>["response"]>
}

const drive = async (
  model: Parameters<typeof streamText>[0]["model"],
  options: { messages?: ModelMessage[]; maxRetries?: number } = {},
): Promise<Driven> => {
  const state = LLMAISDK.adapterState()
  const result = streamText({
    model,
    messages: options.messages ?? [{ role: "user", content: "hello" }],
    allowSystemInMessages: true,
    maxRetries: options.maxRetries ?? 0,
  })
  const events: LLMEvent[] = []
  const parts: AdapterPart[] = []
  for await (const part of result.fullStream) {
    parts.push(part as AdapterPart)
    for (const event of await Effect.runPromise(LLMAISDK.toLLMEvents(state, part as AdapterPart))) {
      events.push(event)
    }
  }
  return { events, parts, response: await result.response }
}

const stepFinishes = (events: ReadonlyArray<LLMEvent>) =>
  events.filter((event): event is Extract<LLMEvent, { type: "step-finish" }> => event.type === "step-finish")

const finishSteps = (parts: ReadonlyArray<AdapterPart>) =>
  parts.filter((part) => part.type === "finish-step")

const unchecked = (input: unknown) => input as AdapterPart

const deepSeekModel: Provider.Model = {
  id: ModelID.make("deepseek-chat"),
  providerID: ProviderID.make("deepseek"),
  api: { id: "deepseek-chat", url: "https://correlation.test/v1", npm: "@ai-sdk/openai-compatible" },
  name: "DeepSeek Chat",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
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

describe("AI SDK request correlation", () => {
  test("links the booked step to the actual doStream response without changing wire bytes", async () => {
    const bodies: string[] = []
    const sent: Array<Record<string, string>> = []
    const received: Array<Record<string, string>> = []
    const fetch = fetchOf(async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "")
      sent.push(requestHeaders(init))
      const response = textStream("ok", "stop", { "x-fixture-attempt": "first" })
      received.push(responseHeaders(response))
      return response
    })
    const ids: string[] = []
    const observed = await drive(evidenceModel(observer(ids), fetch), {
      messages: [{ role: "system", content: "stable system" }, { role: "user", content: "hello" }],
    })
    const control = await drive(
      // Control run without diagnostics: same provider, same messages, no middleware.
      createOpenAICompatible({
        name: "ai-sdk-correlation-test",
        baseURL: "https://correlation.test/v1",
        apiKey: "test-key",
        fetch,
      }).chatModel("fixture-model"),
      { messages: [{ role: "system", content: "stable system" }, { role: "user", content: "hello" }] },
    )

    // Provider request body and headers stay byte-identical; the local id never leaks.
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
    expect(sent[0]).toEqual(sent[1])
    expect(bodies[0]).not.toContain(ids[0])
    expect(JSON.stringify(sent[0])).not.toContain(ids[0])

    // The response header values are unchanged by the copy and reach finish-step.
    const [part] = finishSteps(observed.parts)
    expect(part?.type).toBe("finish-step")
    if (part?.type !== "finish-step") throw new Error("missing finish-step part")
    expect(part.response.headers).toEqual(received[0])
    expect(observed.response.headers).toEqual(received[0])

    expect(ids).toHaveLength(1)
    const finishes = stepFinishes(observed.events)
    expect(finishes).toHaveLength(1)
    expect(finishes[0].requestID).toBe(ids[0])
    // The control stream has no diagnostics, so its step stays unlinked.
    expect(stepFinishes(control.events)).toHaveLength(1)
    expect(stepFinishes(control.events)[0].requestID).toBeUndefined()
  })

  test("associates only the successful attempt after a 503 retry", async () => {
    let attempts = 0
    const received: Array<Record<string, string>> = []
    const fetch = fetchOf(async () => {
      attempts++
      if (attempts === 1) return new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
      const response = textStream("ok", "stop", { "x-fixture-attempt": "second" })
      received.push(responseHeaders(response))
      return response
    })
    const ids: string[] = []
    const observed = await drive(evidenceModel(observer(ids), fetch), { maxRetries: 1 })

    expect(attempts).toBe(2)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    const finishes = stepFinishes(observed.events)
    expect(finishes).toHaveLength(1)
    expect(finishes[0].requestID).toBe(ids[1])
    const [part] = finishSteps(observed.parts)
    if (part?.type !== "finish-step") throw new Error("missing finish-step part")
    expect(part.response.headers).toEqual(received[0])
  })

  test("keeps each continuation round on its own attempt id", async () => {
    let round = 0
    const bodies: string[] = []
    const fetch = fetchOf(async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "")
      round++
      return round === 1
        ? textStream("first part", "length", { "x-fixture-attempt": "one" })
        : textStream("second part", "stop", { "x-fixture-attempt": "two" })
    })
    const ids: string[] = []
    const model = evidenceModel(observer(ids), fetch)
    const result = LLM.withContinuation(
      (messages) => streamText({ model, messages, allowSystemInMessages: true, maxRetries: 0 }),
      [{ role: "user", content: "long answer" }],
      deepSeekModel,
    )
    const state = LLMAISDK.adapterState()
    const events: LLMEvent[] = []
    for await (const part of result.fullStream) {
      for (const event of await Effect.runPromise(LLMAISDK.toLLMEvents(state, part as AdapterPart))) {
        events.push(event)
      }
    }

    expect(round).toBe(2)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    const finishes = stepFinishes(events)
    expect(finishes).toHaveLength(2)
    expect(finishes.map((event) => event.requestID)).toEqual([ids[0], ids[1]])
    // The continuation request carries the assistant prefix, not the correlation id.
    expect(bodies[1]).toContain("first part")
    expect(bodies[1]).not.toContain(ids[0])
    expect(bodies[1]).not.toContain(ids[1])
  })

  test("keeps interleaved concurrent streams on their own ids", async () => {
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch = fetchOf(async (_input, init) => {
      const index = arrived++
      if (index === 1) release()
      if (index === 0) await gate
      return textStream(`reply-${index}`, "stop", { "x-fixture-attempt": String(index) })
    })
    const idsA: string[] = []
    const idsB: string[] = []
    const [a, b] = await Promise.all([
      drive(evidenceModel(observer(idsA), fetch), { messages: [{ role: "user", content: "A" }] }),
      drive(evidenceModel(observer(idsB), fetch), { messages: [{ role: "user", content: "B" }] }),
    ])

    expect(arrived).toBe(2)
    expect(idsA).toHaveLength(1)
    expect(idsB).toHaveLength(1)
    expect(idsA[0]).not.toBe(idsB[0])
    expect(stepFinishes(a.events)[0].requestID).toBe(idsA[0])
    expect(stepFinishes(b.events)[0].requestID).toBe(idsB[0])
  })

  test("stays unlinked when the response has no headers and never invents an empty object", async () => {
    const stripResponse: LanguageModelMiddleware = {
      specificationVersion: "v3",
      async wrapStream({ doStream }) {
        const result = await doStream()
        const { response: _response, ...rest } = result as { response?: unknown }
        return rest as typeof result
      },
    }
    const fetch = fetchOf(async () => textStream("ok"))
    const ids: string[] = []
    const observed = await drive(evidenceModel(observer(ids), fetch, { inner: [stripResponse] }))

    expect(ids).toHaveLength(1)
    const [part] = finishSteps(observed.parts)
    if (part?.type !== "finish-step") throw new Error("missing finish-step part")
    expect(part.response.headers).toBeUndefined()
    expect(stepFinishes(observed.events)).toHaveLength(1)
    expect(stepFinishes(observed.events)[0].requestID).toBeUndefined()
  })

  test("stays unlinked when the headers object is cloned before the SDK sees finish-step", async () => {
    const cloneHeaders: LanguageModelMiddleware = {
      specificationVersion: "v3",
      async wrapStream({ doStream }) {
        const result = await doStream()
        const response = (result as { response?: { headers?: Record<string, string> } }).response
        if (!response?.headers) return result
        return {
          ...(result as object),
          response: { ...response, headers: { ...response.headers } },
        } as typeof result
      },
    }
    const received: Array<Record<string, string>> = []
    const fetch = fetchOf(async () => {
      const response = textStream("ok", "stop", { "x-fixture-attempt": "cloned" })
      received.push(responseHeaders(response))
      return response
    })
    const ids: string[] = []
    const observed = await drive(evidenceModel(observer(ids), fetch, { outer: [cloneHeaders] }))

    expect(ids).toHaveLength(1)
    const [part] = finishSteps(observed.parts)
    if (part?.type !== "finish-step") throw new Error("missing finish-step part")
    // Same content, different object identity: content is preserved but the link is not guessed.
    expect(part.response.headers).toEqual(received[0])
    expect(stepFinishes(observed.events)).toHaveLength(1)
    expect(stepFinishes(observed.events)[0].requestID).toBeUndefined()
  })

  test("binds an independent copy of the response headers without touching the provider response", async () => {
    const ids: string[] = []
    const middleware = RequestEvidence.middleware(observer(ids))
    const original = { "content-type": "text/event-stream", "x-fixture-attempt": "unit" }
    const result = {
      request: { body: "unchanged-body" },
      response: { id: "response-id", modelId: "fixture-model", headers: original },
    }
    const returned = await middleware.wrapStream({ doStream: async () => result })

    expect(ids).toHaveLength(1)
    expect(returned).not.toBe(result)
    const response = (returned as typeof result).response
    // The copy is a different object with identical content; the provider object is untouched.
    expect(response).not.toBe(result.response)
    expect(response.headers).not.toBe(original)
    expect(response.headers).toEqual(original)
    expect(response.id).toBe("response-id")
    expect(result.response.headers).toBe(original)
    expect(original).toEqual({ "content-type": "text/event-stream", "x-fixture-attempt": "unit" })
    expect((returned as typeof result).request).toBe(result.request)
    expect((returned as typeof result).request.body).toBe("unchanged-body")

    expect(RequestEvidence.correlatedResponseRequestID(response.headers)).toBe(ids[0])
    // Contents-equal but identity-distinct objects are not linked.
    expect(RequestEvidence.correlatedResponseRequestID({ ...original })).toBeUndefined()
    expect(RequestEvidence.correlatedResponseRequestID(original)).toBeUndefined()
    expect(RequestEvidence.correlatedResponseRequestID(undefined)).toBeUndefined()
    RequestEvidence.reset()
  })

  test("leaves a result without response headers untouched instead of adding an empty object", async () => {
    const middleware = RequestEvidence.middleware(observer([]))
    const result = { request: { body: "unchanged-body" }, response: { id: "response-id" } }
    const returned = await middleware.wrapStream({ doStream: async () => result })

    expect(returned).toBe(result)
    expect("headers" in (returned as typeof result).response).toBe(false)
  })

  test("leaves a finish-step without response metadata unlinked in the adapter", async () => {
    const state = LLMAISDK.adapterState()
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(
        state,
        unchecked({
          type: "finish-step",
          finishReason: "stop",
          rawFinishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          providerMetadata: undefined,
        }),
      ),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "step-finish" })
    expect("requestID" in events[0]).toBe(false)
  })
})
