import type { SessionQueryResponses } from "@redcode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

export type SessionSearchHit = SessionQueryResponses[200]["results"][number]

export type SearchState = {
  q: string
  hits: SessionSearchHit[]
  scannedParts: number
  nextCursor?: string
  error?: string
}

export type SearchCacheEntry = { input: string; state: SearchState | undefined; scrollTop: number }

// 261122 Red 第一批：搜索状态与请求版本按作用域分开管理。组件只是投影——
// 切走后的迟到响应只能写回自己的条目，同一作用域的新搜索用版本号作废旧响应。
export function createSearchScopes() {
  const cache = new Map<string, SearchCacheEntry>()
  const versions = new Map<string, number>()
  return {
    get: (scope: string) => cache.get(scope),
    save(scope: string, entry: SearchCacheEntry) {
      cache.set(scope, entry)
    },
    clear(scope: string) {
      cache.delete(scope)
      versions.delete(scope)
    },
    /** 登记一次新搜索并返回版本；同一作用域内旧版本随即失效。 */
    begin(scope: string) {
      const version = (versions.get(scope) ?? 0) + 1
      versions.set(scope, version)
      return version
    },
    owns(scope: string, version: number) {
      return versions.get(scope) === version
    },
  }
}

/** 搜索作用域：连接、目录、会话三者任一不同都不是同一份历史。 */
export const searchScopeKey = (input: { url: string; directory: string; sessionID: string }) =>
  `${input.url}\u0000${pathKey(input.directory)}\u0000${input.sessionID}`
