export type Mode = "default" | "none"

// 261128 Red 只在本地交给 transport 之前使用，不能靠远端异常文案判断“未发送”。
export class NotSentError extends Error {}

export interface Options<T> {
  mode?: Mode
  call: () => Promise<T>
  signal?: AbortSignal
  reconnect?: (signal?: AbortSignal) => Promise<void>
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  onFailure?: (input: { error: unknown; attempt: number }) => void
  // 261128 Red 工具是否声明了 readOnlyHint/idempotentHint。未声明时，结果未知的失败立即停止
  // 本次调用并报错；连接恢复留给下一次新调用，不在当前调用里等待重连。
  replaySafe?: boolean
}

const MAX_ATTEMPTS = 3

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("Aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortReason(signal)
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function run<T>(options: Options<T>): Promise<T> {
  const attempts = options.mode === "none" ? 1 : MAX_ATTEMPTS
  const delay = options.delay ?? abortableDelay
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(options.signal)
    try {
      return await options.call()
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal)
      lastError = error
      options.onFailure?.({ error, attempt: attempt + 1 })
      if (!options.replaySafe && !(error instanceof NotSentError)) throw error
      if (attempt + 1 >= attempts) break
      throwIfAborted(options.signal)
      if (options.reconnect) {
        // 260920 Red Reconnect is best effort; preserve the original tool-call error.
        await options.reconnect(options.signal).catch((error) => {
          if (options.signal?.aborted) throw abortReason(options.signal)
          return error
        })
      }
      throwIfAborted(options.signal)
      await delay(1000 * 2 ** attempt, options.signal)
      throwIfAborted(options.signal)
    }
  }

  throw lastError
}

export * as McpRetry from "./retry"
