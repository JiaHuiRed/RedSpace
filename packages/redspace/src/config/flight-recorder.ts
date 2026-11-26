import { Cause, Effect, Exit, Option, Schema } from "effect"
import { PositiveInt } from "@redcode-ai/core/schema"

// 261126 Red 硬上限的依据：全局/每会话边界查询是 LIMIT 1 OFFSET keep-1 的索引扫描，
// 成本随 keep 线性增长。当前容量基准只实测到 100 万行，因此 100 万是已证明可承受的上限；
// 更高的取值没有实测依据，且会在写锁内线性放大边界扫描。保留期限取 10 年作为语义上限，
// 更久等同于禁用；需要永久保留时省略该字段。
export const MAX_ROWS = 1_000_000
export const MAX_RETENTION_MS = 10 * 365 * 24 * 60 * 60 * 1000

const Rows = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ROWS))
const Age = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_RETENTION_MS))

// 261126 Red FR-05 容量策略归属全局配置。默认每会话 128 条，全局最多 100,000 条；
// 超出全局上限时按最早顺序分批永久淘汰请求记录。保留期限默认不启用。
// PositiveInt 的底层 Schema.Int 已用 Number.isSafeInteger 拒绝 unsafe integer。
export const Info = Schema.Struct({
  max_requests_per_session: Schema.optional(Rows).annotate({
    description: `Maximum flight-recorder request rows kept per session (default: 128; maximum: ${MAX_ROWS}). Older rows are removed in small batches.`,
  }),
  max_total_requests: Schema.optional(Rows).annotate({
    description: `Maximum flight-recorder request rows kept in the database (default: 100000; maximum: ${MAX_ROWS}). Beyond this cap the oldest requests are permanently removed in small batches. Steps, messages and sessions are never deleted.`,
  }),
  retention_ms: Schema.optional(Age).annotate({
    description: `Maximum age of a flight-recorder request row in milliseconds (maximum: ${MAX_RETENTION_MS}, about 10 years). Omit to disable age-based retention (default: disabled).`,
  }),
}).annotate({ identifier: "FlightRecorderConfig" })

export type Input = typeof Info.Type

export type Resolved = {
  readonly maxRequestsPerSession: number
  readonly maxTotalRequests: number
  readonly retentionMs?: number
}

export const DEFAULT_SESSION_ROWS = 128
export const DEFAULT_TOTAL_ROWS = 100_000

export function resolve(input?: Input): Resolved {
  const value = Schema.decodeUnknownSync(Info)(input ?? {})
  return {
    maxRequestsPerSession: value.max_requests_per_session ?? DEFAULT_SESSION_ROWS,
    maxTotalRequests: value.max_total_requests ?? DEFAULT_TOTAL_ROWS,
    ...(value.retention_ms === undefined ? {} : { retentionMs: value.retention_ms }),
  }
}

export type Loaded = { readonly ok: true; readonly policy: Resolved } | { readonly ok: false; readonly error: string }

// 261126 Red 启动清理必须使用真正加载成功的全局配置，不能先按默认值删旧库。这里复用应用
// 同一个 Config 服务（共享 memoMap），由它完成 jsonc/本地层/托管配置的全部解析与校验；
// 读取或校验失败返回 ok:false，调用方不得退回默认策略清理。
function makeRuntime() {
  return Promise.all([import("./config"), import("@/effect/run-service")]).then(([config, runtime]) =>
    runtime.makeRuntime(config.Config.Service, config.Config.defaultLayer),
  )
}

let runtime: ReturnType<typeof makeRuntime> | undefined

export async function loadGlobal(refresh = false): Promise<Loaded> {
  try {
    const service = await (runtime ??= makeRuntime())
    const exit = await service.runPromiseExit((config) =>
      Effect.gen(function* () {
        // 261126 Red 重试/刷新时先失效缓存，用户修好配置文件后不需要重启进程。
        if (refresh) yield* config.invalidate()
        const failure = yield* config.getGlobalError()
        if (Option.isSome(failure)) return { ok: false as const, error: failure.value }
        const info = yield* config.getGlobal()
        return { ok: true as const, info }
      }),
    )
    if (Exit.isFailure(exit)) return { ok: false, error: Cause.pretty(exit.cause) }
    if (!exit.value.ok) return exit.value
    try {
      return { ok: true, policy: resolve(exit.value.info.flight_recorder) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  } catch (error) {
    // 261126 Red 配置层自举失败（动态模块/运行时构建）同样按“未成功读取”处理。
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export * as ConfigFlightRecorder from "./flight-recorder"
