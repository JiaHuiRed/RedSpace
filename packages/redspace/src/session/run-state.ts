import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context, Semaphore } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly isBusy: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    onCancelled?: Effect.Effect<void>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly scheduleCompaction: <E>(
    sessionID: SessionID,
    prepare: Effect.Effect<CompactionWork, E>,
    loop: Effect.Effect<unknown>,
  ) => Effect.Effect<void, E>
  readonly runScheduledCompaction: (sessionID: SessionID) => Effect.Effect<CompactionResult | undefined>
  readonly markStopped: (sessionID: SessionID) => Effect.Effect<void>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionRunState") {}

type RunnerFrame = { runner: Runner.Runner<MessageV2.WithParts>; cancelled: boolean }
type CompactionResult = "continue" | "stop"
type CompactionWork = { run: Effect.Effect<CompactionResult>; clearAdmission: Effect.Effect<void> }
type CompactionJob = CompactionWork & { phase: "queued" | "running" | "settling" }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, RunnerFrame>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            for (const frame of runners.values()) frame.cancelled = true
            yield* Effect.forEach(runners.values(), (frame) => frame.runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return {
          runners,
          scope,
          compactions: new Map<SessionID, CompactionJob>(),
          compactionAdmission: Semaphore.makeUnsafe(1),
        }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      const frame = { runner: next, cancelled: false }
      data.runners.set(sessionID, frame)
      return frame
    })

    // 261031 Red busy 判定查询：提交方用它决定忙碌引导是否落 pending_steer（待消费形态）。
    const isBusy = Effect.fn("SessionRunState.isBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.runners.get(sessionID)?.runner.busy ?? false
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.runner.busy) yield* busyError(sessionID)
    })

    const finishCompaction = Effect.fnUntraced(function* (
      jobs: Map<SessionID, CompactionJob>,
      sessionID: SessionID,
      job: CompactionJob,
    ) {
      if (job.phase === "settling") return
      job.phase = "settling"
      yield* job.clearAdmission.pipe(Effect.ensuring(Effect.sync(() => jobs.delete(sessionID))))
    })

    const scheduleCompaction = Effect.fn("SessionRunState.scheduleCompaction")(function* <E>(
      sessionID: SessionID,
      prepare: Effect.Effect<CompactionWork, E>,
      loop: Effect.Effect<unknown>,
    ) {
      const data = yield* InstanceState.get(state)
      yield* data.compactionAdmission.withPermits(1)(
        Effect.gen(function* () {
          if (data.compactions.has(sessionID)) return
          const job: CompactionJob = { ...(yield* prepare), phase: "queued" }
          data.compactions.set(sessionID, job)
          // 261124 Red Joining an existing runner does not schedule work. If it exits
          // before claiming the job, start the next runner; never retry a claimed summary.
          // docs/notes/implemented/feature/2026-10-10-native-compaction.md
          yield* Effect.gen(function* () {
            while (job.phase === "queued") yield* loop
          }).pipe(
            Effect.ignoreCause,
            Effect.ensuring(
              Effect.suspend(() =>
                job.phase === "queued" ? finishCompaction(data.compactions, sessionID, job) : Effect.void,
              ),
            ),
            Effect.interruptible,
            Effect.forkIn(data.scope, { startImmediately: true }),
          )
        }).pipe(Effect.uninterruptible),
      )
    })

    const runScheduledCompaction = Effect.fn("SessionRunState.runScheduledCompaction")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const job = data.compactions.get(sessionID)
          if (job?.phase !== "queued") return Effect.succeed(undefined)
          job.phase = "running"
          return restore(job.run).pipe(Effect.ensuring(finishCompaction(data.compactions, sessionID, job)))
        }),
      )
    })

    // 261107 Red 取消必须落到执行层：后台 job 只是等 Deferred 的外壳，真正的模型循环
    // fork 在 runner scope 里，中断 job 带不走它。job id 即会话 id，按 id 逐个停 runner，
    // 面板上的「已取消」才等于执行真的停下（261107 实测：cancelled 后子会话仍在写文件）。
    const stopRunner = Effect.fnUntraced(function* (runners: Map<SessionID, RunnerFrame>, sessionID: SessionID) {
      const existing = runners.get(sessionID)
      if (existing?.runner.busy) existing.cancelled = true
      if (!existing || !existing.runner.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.runner.cancel
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const stop = Effect.fnUntraced(function* (id: SessionID) {
        const job = data.compactions.get(id)
        if (job?.phase === "queued") yield* finishCompaction(data.compactions, id, job).pipe(Effect.uninterruptible)
        yield* stopRunner(data.runners, id)
      })
      const cancelled = yield* background.cancelTree(sessionID)
      yield* Effect.forEach(cancelled, (jobID) => stop(jobID as SessionID), { discard: true })
      yield* stop(sessionID)
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      onCancelled?: Effect.Effect<void>,
    ) {
      const frame = yield* runner(sessionID, onInterrupt)
      const result = yield* frame.runner.ensureRunning(work)
      if (frame.cancelled && onCancelled) yield* onCancelled
      return result
    })

    const markStopped = Effect.fn("SessionRunState.markStopped")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const frame = data.runners.get(sessionID)
      if (frame?.runner.busy) frame.cancelled = true
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      const frame = yield* runner(sessionID, onInterrupt)
      return yield* frame.runner
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({
      isBusy,
      assertNotBusy,
      cancel,
      ensureRunning,
      scheduleCompaction,
      runScheduledCompaction,
      markStopped,
      startShell,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
