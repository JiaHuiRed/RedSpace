import { Cause, Exit, Schema } from "effect"
import { and, desc, eq, notInArray } from "drizzle-orm"
import type { LLMEvent } from "@redcode-ai/llm"
import { Database } from "@/storage/db"
import type { ModelID, ProviderID } from "@/provider/schema"
import type { MessageID, SessionID } from "./schema"
import { FlightRequestTable } from "./flight-request.sql"
import { CaptureFailureReasons, tokenCount } from "./request-evidence"
import type {
  CaptureObservation,
  EventObservation,
  ObserverHooks,
  ProviderUsageObservation,
  Runtime,
} from "./request-evidence"

// 261126 Red 每会话只保留最近 128 次真实模型请求。裁剪与插入在同一个短事务里完成，
// 索引 (session_id, time_created, id) 直接服务「最新 128」子查询；结算只用 UPDATE，
// 已被裁剪或淘汰的行不会因为迟到的 finish/错误响应被复活。
export const KEEP_PER_SESSION = 128
// provider/model/会话/消息/关联号都是短标识；超限视为不可信输入，整行跳过而不截断成另一个 ID。
const MAX_ID_BYTES = 512

export const PrefixChange = Schema.Literals(["baseline", "unchanged", "append", "rewind", "rewrite"])
type PrefixChange = typeof PrefixChange.Type

const metric = Schema.optional(Schema.Finite)
const Section = Schema.Struct({
  change: PrefixChange,
  count: Schema.Int,
  bytes: Schema.Int,
  countDelta: Schema.optional(Schema.Int),
  bytesDelta: Schema.optional(Schema.Int),
  firstDifference: Schema.optional(Schema.Int),
})
const Comparison = Schema.Literals(["baseline", "unchanged", "changed"])
const Capture = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("captured"),
    previousRequestID: Schema.optional(Schema.String),
    system: Section,
    tools: Section,
    history: Section,
    parameters: PrefixChange,
    wire: Comparison,
    serialized: Comparison,
    affinity: Schema.Literals(["baseline", "unchanged", "changed", "unknown"]),
    compacted: Schema.optional(Schema.Literal(true)),
    compression: Schema.optional(
      Schema.Struct({
        receipts: Schema.Int,
        blockCount: Schema.Finite,
        inputTokensEstimated: Schema.Finite,
        summaryTokensEstimated: Schema.Finite,
        netSavingsEstimated: Schema.Finite,
      }),
    ),
  }),
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: Schema.Literals(CaptureFailureReasons) }),
])

export const Diagnostics = Schema.Struct({
  version: Schema.Literal(1),
  runtime: Schema.Literals(["ai-sdk", "native"]),
  capture: Schema.optional(Capture),
  instructions: Schema.optional(
    Schema.Struct({
      source: Schema.Literal("provider"),
      inputTokens: metric,
      cachedTokens: metric,
      cacheWriteTokens: metric,
      missTokens: metric,
    }),
  ),
  unattributedInputTokens: metric,
}).annotate({ identifier: "FlightRecorderDiagnostics" })
type Diagnostics = typeof Diagnostics.Type

// 261126 Red 行 data 的唯一契约：只允许这些白名单字段。present zero 与 missing 由键是否
// 出现区分；缺 usage/时间就是未知，不借用同一步、重试或续写的另一份数字。
export type RequestData = {
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown"
  // 总输入，含缓存命中/写入。
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  // 派生值 = input - cacheRead（未从缓存读取，包含缓存写入）。两端都有且 read ≤ input 时
  // 才出现；read > input 属矛盾数据，omit 而不是钳成 0，原始 read/input 仍保留供检查。
  readonly cacheMiss?: number
  readonly durationMs?: number
  // 从出站开始到第一个真实流事件；不是可见首字，也不由 HTTP 200 推断。
  readonly firstEventMs?: number
  // 缺省 = 本次没有可比较的前缀证据（unsupported/首次基线之前）；compressed 只表示
  // 「本请求之前观察到新压缩」，不是「确定没有缓存」。
  readonly prefix?: {
    readonly system: PrefixChange
    readonly tools: PrefixChange
    readonly history: PrefixChange
    readonly compressed: boolean
  }
  readonly diagnostics?: Diagnostics
}

type Usage = Pick<RequestData, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheMiss">
type SectionObservation = Extract<CaptureObservation, { status: "captured" }>["system"]
type UsageEvent = Extract<EventObservation, { type: "usage" }>

type Attempt = {
  readonly requestID: string
  readonly startedAt: number
  capture?: typeof Capture.Type
  firstEventAt?: number
  // 261126 Red AI SDK 只认同 ID 的原始 vendor usage；native 用共享 LLMEvent 的归一化值。
  raw?: ProviderUsageObservation
  usage?: UsageEvent
  // SDK 的 finish part（providerUsage 钩子）或 native 的 finish 事件是本请求完成的证据；
  // 不用整流退出/总量推断单次请求。
  finishedAt?: number
  error: boolean
  settled: boolean
}

export type Recorder = Required<ObserverHooks> & {
  readonly settle: (exit: Exit.Exit<unknown, unknown>) => void
}

export type CreateInput = {
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly providerID: ProviderID
  readonly modelID: ModelID
  readonly runtime: Runtime
  readonly anthropic?: boolean
}

const cacheMiss = (input: number | undefined, cacheRead: number | undefined) =>
  input === undefined || cacheRead === undefined || cacheRead > input ? undefined : input - cacheRead

// 261126 Red Anthropic 把输入拆成未缓存、缓存读取、缓存写入三项，三项齐全才能确定总量。
function splitInput(base: number | undefined, read: number | undefined, write: number | undefined) {
  return base === undefined || read === undefined || write === undefined ? undefined : tokenCount(base + read + write)
}

function reportedUsage(fields: ProviderUsageObservation["fields"], anthropic: boolean | undefined): Usage {
  const base = tokenCount(fields["input_tokens"] ?? fields["prompt_tokens"])
  const read = tokenCount(fields["cache_read_input_tokens"])
  const write = tokenCount(fields["cache_creation_input_tokens"])
  const split = anthropic || read !== undefined || write !== undefined
  const input = split ? splitInput(base, read, write) : base
  const hit = tokenCount(fields["prompt_cache_hit_tokens"])
  const miss = tokenCount(fields["prompt_cache_miss_tokens"])
  // 261126 Red 部分兼容网关的 hit 是累计值。按本次输入上限和可用的 hit+miss 分项核验。
  const validBreakdown =
    !split &&
    input !== undefined &&
    (hit === undefined || hit <= input) &&
    (miss === undefined || miss <= input) &&
    (hit === undefined || miss === undefined || hit + miss === input)
  const cacheRead = split
    ? read
    : (tokenCount(fields["input_tokens_details.cached_tokens"] ?? fields["prompt_tokens_details.cached_tokens"]) ??
      (validBreakdown ? hit : undefined))
  const cacheWrite = split ? write : tokenCount(fields["input_tokens_details.cache_write_tokens"])
  const output = tokenCount(fields["output_tokens"] ?? fields["completion_tokens"])
  const uncached = cacheMiss(input, cacheRead) ?? (cacheRead === undefined && validBreakdown ? miss : undefined)
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(uncached === undefined ? {} : { cacheMiss: uncached }),
  }
}

// 261126 Red native 走共享 LLMEvent 的归一化 usage：inputTokens 已是含缓存的总输入，
// 三个 breakdown 字段各自可选，缺失仍然保持缺失。
function normalizedUsage(observation: UsageEvent, anthropic: boolean | undefined): Usage {
  const usage = observation.rawUsage
  const cacheRead = tokenCount(usage?.cacheReadInputTokens)
  const cacheWrite = tokenCount(usage?.cacheWriteInputTokens)
  const input = anthropic
    ? splitInput(tokenCount(usage?.nonCachedInputTokens), cacheRead, cacheWrite)
    : tokenCount(usage?.inputTokens)
  const output = tokenCount(usage?.outputTokens)
  const miss = cacheMiss(input, cacheRead)
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(miss === undefined ? {} : { cacheMiss: miss }),
  }
}

function section(observation: SectionObservation): typeof Section.Type {
  return {
    change: observation.change,
    count: observation.count,
    bytes: observation.length,
    countDelta: observation.countDelta,
    bytesDelta: observation.lengthDelta,
    firstDifference: observation.difference?.index,
  }
}

function diagnosticsCapture(observation: CaptureObservation): typeof Capture.Type {
  if (observation.status === "unsupported") return { status: observation.status, reason: observation.reason }
  const receipts = observation.afterCompression
  return {
    status: observation.status,
    previousRequestID: observation.previousRequestID,
    system: section(observation.system),
    tools: section(observation.tools),
    history: section(observation.history),
    parameters: observation.parameters.change,
    wire: observation.wire.change,
    serialized: observation.serialized.change,
    affinity: observation.affinityChange,
    compacted: observation.compacted === true ? true : undefined,
    compression:
      receipts.length === 0
        ? undefined
        : {
            receipts: receipts.length,
            ...receipts.reduce(
              (total, record) => ({
                blockCount: total.blockCount + record.blockCount,
                inputTokensEstimated: total.inputTokensEstimated + record.inputTokensEstimated,
                summaryTokensEstimated: total.summaryTokensEstimated + record.summaryTokensEstimated,
                netSavingsEstimated: total.netSavingsEstimated + record.netSavingsEstimated,
              }),
              { blockCount: 0, inputTokensEstimated: 0, summaryTokensEstimated: 0, netSavingsEstimated: 0 },
            ),
          },
  }
}

// 被下一次出站取代时，只有已经看到终态 finish 且没有错误的才算完成；其余保持未知。
function supersededOutcome(attempt: Attempt): RequestData["outcome"] {
  if (attempt.error) return "failed"
  return attempt.finishedAt !== undefined ? "completed" : "unknown"
}

export function create(input: CreateInput): Recorder {
  let current: Attempt | undefined
  const baseDiagnostics = { version: 1 as const, runtime: input.runtime }

  const settle = (attempt: Attempt, outcome: RequestData["outcome"]) => {
    if (attempt.settled) return
    attempt.settled = true
    // 261126 Red AI SDK 只认同 ID 的原始 vendor usage；native 才用归一化的 step-finish。
    const fields = attempt.raw?.fields ?? attempt.usage?.providerFields
    const usage = fields
      ? reportedUsage(fields, input.anthropic)
      : attempt.usage
        ? normalizedUsage(attempt.usage, input.anthropic)
        : undefined
    const attribution = attempt.raw ?? attempt.usage
    const capture = attempt.capture
    // 261126 Red SDK 收到 provider finish 后可能还要等本地工具或权限；那段不是模型耗时。
    const end = attempt.finishedAt ?? (outcome === "unknown" ? undefined : Date.now())
    const data: RequestData = {
      outcome,
      ...(usage ?? {}),
      ...(end === undefined ? {} : { durationMs: Math.max(0, end - attempt.startedAt) }),
      ...(attempt.firstEventAt === undefined || (end !== undefined && attempt.firstEventAt > end)
        ? {}
        : { firstEventMs: Math.max(0, attempt.firstEventAt - attempt.startedAt) }),
      ...(capture?.status === "captured"
        ? {
            prefix: {
              system: capture.system.change,
              tools: capture.tools.change,
              history: capture.history.change,
              compressed: capture.compression !== undefined || capture.compacted === true,
            },
          }
        : {}),
      diagnostics: {
        ...baseDiagnostics,
        capture,
        instructions: attribution?.instructions && { source: "provider", ...attribution.instructions },
        unattributedInputTokens: attribution?.unattributedInputTokens,
      },
    }
    try {
      // 只更新已插入的行：迟到结算不能把已裁剪/淘汰的请求重新写回来。
      Database.use((db) =>
        db.update(FlightRequestTable).set({ data }).where(eq(FlightRequestTable.id, attempt.requestID)).run(),
      )
    } catch {
      // 261126 Red 取证写失败不得影响模型请求或流；最坏结果是该行停在 outcome=unknown。
    }
  }

  const persist = (attempt: Attempt) => {
    const ids = [attempt.requestID, input.sessionID, input.messageID, input.providerID, input.modelID]
    if (ids.some((id) => Buffer.byteLength(id, "utf8") > MAX_ID_BYTES)) return
    try {
      Database.transaction((tx) => {
        tx.insert(FlightRequestTable)
          .values({
            id: attempt.requestID,
            session_id: input.sessionID,
            message_id: input.messageID,
            time_created: attempt.startedAt,
            provider_id: input.providerID,
            model_id: input.modelID,
            // 261126 Red 尝试开始就建行：网络/HTTP 失败或 body 超限也留一条，prefix 缺省=未观察。
            data: { outcome: "unknown", diagnostics: baseDiagnostics },
          })
          .onConflictDoNothing()
          .run()
        tx.delete(FlightRequestTable)
          .where(
            and(
              eq(FlightRequestTable.session_id, input.sessionID),
              notInArray(
                FlightRequestTable.id,
                tx
                  .select({ id: FlightRequestTable.id })
                  .from(FlightRequestTable)
                  .where(eq(FlightRequestTable.session_id, input.sessionID))
                  .orderBy(desc(FlightRequestTable.time_created), desc(FlightRequestTable.id))
                  .limit(KEEP_PER_SESSION),
              ),
            ),
          )
          .run()
      })
    } catch {
      // 261126 Red 表缺失、外键未就绪或磁盘错误都只丢这一行，不影响请求本身。
    }
  }

  return {
    started(requestID, startedAt) {
      // 261126 Red 出站是唯一插入点。同一路流里新的出站（SDK 重试/续写）先收尾上一个
      // 未结算的尝试，后续事件与原始 usage 只归新尝试，绝不把多次尝试汇总成一行。
      if (current && !current.settled) settle(current, supersededOutcome(current))
      const attempt: Attempt = {
        requestID,
        startedAt,
        error: false,
        settled: false,
      }
      current = attempt
      persist(attempt)
    },
    capture(observation: CaptureObservation) {
      // 261126 Red 只认与当前出站同 ID 的观察；迟到/不符 ID 的 capture 直接忽略，
      // 不抢新 current，也不会复活已淘汰的行。
      if (!current || current.requestID !== observation.requestID) return
      current.capture = diagnosticsCapture(observation)
    },
    event(event: LLMEvent, observation: EventObservation | undefined) {
      const attempt = current
      if (!attempt || attempt.settled) return
      if (attempt.firstEventAt === undefined) attempt.firstEventAt = Date.now()
      if (event.type === "provider-error") {
        attempt.error = true
        return
      }
      // AI SDK 的完成证据来自同请求的 finish part（providerUsage），整流 finish 不补账；
      // native 没有原始 usage 旁路，共享 LLMEvent 的 finish 才是本请求的终态。
      if (event.type === "finish") {
        if (input.runtime === "native") attempt.finishedAt ??= Date.now()
        return
      }
      if (input.runtime !== "native" || event.type !== "step-finish" || attempt.usage) return
      if (observation?.type === "usage" && observation.usageStatus === "reported") attempt.usage = observation
    },
    providerUsage(observation) {
      // 261126 Red 同 ID 的 finish part 同时是本次请求的完成证据与 usage 来源；不符 ID 忽略。
      const attempt = current
      if (!attempt || attempt.settled || attempt.requestID !== observation.requestID) return
      attempt.raw = observation
      attempt.finishedAt ??= Date.now()
    },
    rejected(requestID) {
      // 261126 Red SDK 自动重试会吞掉 doStream 拒绝；这里按出站 ID 立即结算失败，
      // 不等整流退出，避免下一次 started 把这次记成 unknown。
      const attempt = current
      if (!attempt || attempt.settled || attempt.requestID !== requestID) return
      attempt.error = true
      settle(attempt, "failed")
      current = undefined
    },
    settle(exit) {
      const attempt = current
      if (!attempt) return
      const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      const failed = attempt.error || (Exit.isFailure(exit) && !interrupted)
      // 261126 Red 先判失败：SDK 在解析/传输失败时也可能先吐一个 error finish part，
      // 不能让「看到 finish」盖过整流失败。取消后已收到完成 part 的仍按完成记。
      const outcome = failed ? "failed" : attempt.finishedAt !== undefined ? "completed" : interrupted ? "cancelled" : "unknown"
      settle(attempt, outcome)
      current = undefined
    },
  }
}

export * as FlightRecording from "./flight-recording"
