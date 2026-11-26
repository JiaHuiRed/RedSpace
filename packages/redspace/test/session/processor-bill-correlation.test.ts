import { NodeFileSystem } from "@effect/platform-node"
import { LLMEvent, Usage } from "@redcode-ai/llm"
import { expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@redcode-ai/core/util/log"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snippet } from "@/session/snippet"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const agent = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
  Snippet.defaultLayer,
).pipe(Layer.provideMerge(infra))
const processorLayer = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({})),
  Layer.provideMerge(deps),
)

// 261126 Red The processor must persist the request id atomically with the
// booked cost/tokens; feed it through the same LLM.Service seam it consumes.
const it = (events: ReadonlyArray<LLMEvent>) =>
  testEffect(
    processorLayer.pipe(Layer.provide(Layer.succeed(LLM.Service, { stream: () => Stream.fromIterable(events) }))),
  )

const usage = new Usage({ inputTokens: 10, outputTokens: 2 })

const booked = (requestID?: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-0" }),
  LLMEvent.textDelta({ id: "text-0", text: "ok" }),
  LLMEvent.textEnd({ id: "text-0" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop", usage, requestID }),
  LLMEvent.finish({ reason: "stop", usage }),
]

const run = () =>
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const processors = yield* SessionProcessor.Service
    const session = yield* Session.Service
    const provider = yield* Provider.Service

    const chat = yield* session.create({})
    const parent = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: parent.id,
      sessionID: chat.id,
      type: "text",
      text: "hi",
    })
    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      path: { cwd: path.resolve(directory), root: path.resolve(directory) },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: parent.id,
      time: { created: Date.now() },
      finish: "end_turn",
    }
    yield* session.updateMessage(msg)
    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })

    yield* awaitWithTimeout(
      handle.process({
        user: parent,
        sessionID: chat.id,
        model,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "hi" }],
        tools: {},
      }),
      "processor did not finish",
      "10 seconds",
    )
    return MessageV2.parts(msg.id).find((part) => part.type === "step-finish")
  })

it(booked("req-native-1")).instance(
  "persists the request id atomically with the booked cost and tokens",
  Effect.gen(function* () {
    const part = yield* run()
    expect(part).toMatchObject({
      type: "step-finish",
      requestID: "req-native-1",
      tokens: { input: 10, output: 2 },
    })
    if (part?.type === "step-finish") expect(typeof part.cost).toBe("number")
  }),
  { config: cfg },
)

it(booked()).instance(
  "leaves old or unlinked bills without a request id",
  Effect.gen(function* () {
    const part = yield* run()
    expect(part).toMatchObject({ type: "step-finish", tokens: { input: 10, output: 2 } })
    if (part?.type === "step-finish") expect("requestID" in part).toBe(false)
  }),
  { config: cfg },
)

it(booked()).instance(
  "decodes legacy step-finish rows that predate the request id",
  Effect.sync(() => {
    const decoded = Schema.decodeUnknownSync(MessageV2.StepFinishPart)({
      id: "prt_legacy",
      messageID: "msg_legacy",
      sessionID: "ses_legacy",
      type: "step-finish",
      reason: "stop",
      cost: 0.01,
      tokens: { total: 12, input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(decoded.requestID).toBeUndefined()
    expect(decoded.cost).toBe(0.01)
  }),
  { config: cfg },
)

it(booked()).instance(
  "bounds the persisted request id at the schema contract",
  Effect.sync(() => {
    const part = (requestID: string) => ({
      id: "prt_bounded",
      messageID: "msg_bounded",
      sessionID: "ses_bounded",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      requestID,
    })

    // The only producer is RequestEvidence.withRequest (crypto.randomUUID(), 36 chars).
    expect(
      Schema.decodeUnknownSync(MessageV2.StepFinishPart)(part(crypto.randomUUID())).requestID,
    ).toHaveLength(36)
    // The persistence contract owns an explicit cap, not an unbounded string.
    expect(Schema.decodeUnknownSync(MessageV2.StepFinishPart)(part("x".repeat(64))).requestID).toHaveLength(64)
    expect(() => Schema.decodeUnknownSync(MessageV2.StepFinishPart)(part("x".repeat(65)))).toThrow()
  }),
  { config: cfg },
)
