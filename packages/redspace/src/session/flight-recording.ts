import { Cause, Exit } from "effect"
import { and, desc, eq, notInArray } from "drizzle-orm"
import type { LLMEvent } from "@redcode-ai/llm"
import { Database } from "@/storage/db"
import type { ModelID, ProviderID } from "@/provider/schema"
import type { MessageID, SessionID } from "./schema"
import { FlightRequestTable } from "./flight-request.sql"
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

export type PrefixChange = "baseline" | "unchanged" | "append" | "rewind" | "rewrite"

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
}

type Usage = Pick<RequestData, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheMiss">
type Prefix = NonNullable<RequestData["prefix"]>

type Attempt = {
  readonly requestID: string
  readonly startedAt: number
  prefix?: Prefix
  firstEventAt?: number
  // 261126 Red AI SDK 只认同 ID 的原始 vendor usage；native 用共享 LLMEvent 的归一化值。
  raw?: ProviderUsageObservation
  usage?: Usage
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
}

const cacheMiss = (input: number | undefined, cacheRead: number | undefined) =>
  input === undefined || cacheRead === undefined || cacheRead > input ? undefined : input - cacheRead

// 261126 Red 原始 vendor usage → 行字段。只读同 ID 观察过的白名单数值：
// - OpenAI Chat: prompt_tokens/completion_tokens（总输入已含缓存）
// - OpenAI Responses: input_tokens/output_tokens（总输入已含缓存）
// - Anthropic: input_tokens 是未缓存部分，需加上 cache_read/cache_creation 才是总输入
// 任一缓存字段缺失就保持 missing（不补 0）；read > input 的矛盾样本只保留原值、不派生 miss。
function reportedUsage(observation: ProviderUsageObservation): Usage {
  const fields = observation.fields
  const cacheRead =
    fields["input_tokens_details.cached_tokens"] ??
    fields["prompt_tokens_details.cached_tokens"] ??
    fields["cache_read_input_tokens"]
  const cacheWrite = fields["input_tokens_details.cache_write_tokens"] ?? fields["cache_creation_input_tokens"]
  const anthropic = fields["cache_read_input_tokens"] !== undefined || fields["cache_creation_input_tokens"] !== undefined
  const base = fields["input_tokens"] ?? fields["prompt_tokens"]
  const input = base === undefined ? undefined : anthropic ? base + (cacheRead ?? 0) + (cacheWrite ?? 0) : base
  const output = fields["output_tokens"] ?? fields["completion_tokens"]
  const miss = cacheMiss(input, cacheRead)
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(miss === undefined ? {} : { cacheMiss: miss }),
  }
}

// 261126 Red native 走共享 LLMEvent 的归一化 usage：inputTokens 已是含缓存的总输入，
// 三个 breakdown 字段各自可选，缺失仍然保持缺失。
function normalizedUsage(observation: EventObservation): Usage | undefined {
  if (observation.type !== "usage" || observation.usageStatus !== "reported") return
  const input = observation.rawUsage?.inputTokens
  const cacheRead = observation.rawUsage?.cacheReadInputTokens
  const miss = cacheMiss(input, cacheRead)
  return {
    ...(input === undefined ? {} : { input }),
    ...(observation.rawUsage?.outputTokens === undefined ? {} : { output: observation.rawUsage.outputTokens }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(observation.rawUsage?.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWrite: observation.rawUsage.cacheWriteInputTokens }),
    ...(miss === undefined ? {} : { cacheMiss: miss }),
  }
}

function prefix(observation: Extract<CaptureObservation, { status: "captured" }>): Prefix {
  return {
    system: observation.system.change,
    tools: observation.tools.change,
    history: observation.history.change,
    // DCP 回执与本地 native compaction 标记任一成立即算「压缩过」；首次基线不猜。
    compressed: observation.afterCompression.length > 0 || observation.compacted === true,
  }
}

// 被下一次出站取代时，只有已经看到终态 finish 且没有错误的才算完成；其余保持未知。
function supersededOutcome(attempt: Attempt): RequestData["outcome"] {
  if (attempt.error) return "failed"
  return attempt.finishedAt !== undefined ? "completed" : "unknown"
}

export function create(input: CreateInput): Recorder {
  let current: Attempt | undefined

  const settle = (attempt: Attempt, outcome: RequestData["outcome"]) => {
    if (attempt.settled) return
    attempt.settled = true
    // 261126 Red AI SDK 只认同 ID 的原始 vendor usage；native 才用归一化的 step-finish。
    const usage = attempt.raw
      ? reportedUsage(attempt.raw)
      : input.runtime === "native"
        ? attempt.usage
        : undefined
    // 261126 Red SDK 收到 provider finish 后可能还要等本地工具或权限；那段不是模型耗时。
    const end = attempt.finishedAt ?? (outcome === "unknown" ? undefined : Date.now())
    const data: RequestData = {
      outcome,
      ...(usage ?? {}),
      ...(end === undefined ? {} : { durationMs: Math.max(0, end - attempt.startedAt) }),
      ...(attempt.firstEventAt === undefined || (end !== undefined && attempt.firstEventAt > end)
        ? {}
        : { firstEventMs: Math.max(0, attempt.firstEventAt - attempt.startedAt) }),
      ...(attempt.prefix ? { prefix: attempt.prefix } : {}),
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
            data: { outcome: "unknown" },
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
      // unsupported（body-too-large/invalid-json/shape）没有可比较前缀，保持 prefix 缺省。
      if (observation.status === "captured") current.prefix = prefix(observation)
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
      attempt.usage = observation ? normalizedUsage(observation) : undefined
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
