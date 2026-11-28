import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { Bus } from "../../src/bus"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Question.layer.pipe(Layer.provideMerge(Bus.layer)),
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  const bus = yield* Bus.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* bus.subscribeCallback(Question.Event.Asked, () => Queue.offerUnsafe(asked, undefined))
  yield* Effect.addFinalizer(() => Effect.sync(off))

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("tool.question", () => {
  it.instance("returns the user's answer with a header longer than twelve characters", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )
})
