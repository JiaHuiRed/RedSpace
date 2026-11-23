import { describe, expect, test } from "bun:test"
import { createSearchScopes, searchScopeKey } from "./search-scope"

describe("search scope key", () => {
  test("separates connection, directory and session", () => {
    const base = { url: "http://127.0.0.1:4097", directory: "/repo/one", sessionID: "ses_1" }
    expect(searchScopeKey(base)).toBe(searchScopeKey({ ...base }))
    expect(searchScopeKey(base)).not.toBe(searchScopeKey({ ...base, url: "http://127.0.0.1:4098" }))
    expect(searchScopeKey(base)).not.toBe(searchScopeKey({ ...base, directory: "/repo/two" }))
    expect(searchScopeKey(base)).not.toBe(searchScopeKey({ ...base, sessionID: "ses_2" }))
  })

  test("normalizes Windows separators and a trailing slash", () => {
    expect(searchScopeKey({ url: "u", directory: "C:\\Repo\\One\\", sessionID: "s" })).toBe(
      searchScopeKey({ url: "u", directory: "C:/Repo/One", sessionID: "s" }),
    )
  })
})

describe("search scopes", () => {
  test("keeps each scope's input, hits, cursor and scroll separate", () => {
    const scopes = createSearchScopes()
    scopes.save("A", {
      input: "needle",
      state: { q: "needle", hits: [], scannedParts: 3, nextCursor: "c1" },
      scrollTop: 42,
    })
    expect(scopes.get("B")).toBeUndefined()
    expect(scopes.get("A")?.state?.nextCursor).toBe("c1")
    expect(scopes.get("A")?.scrollTop).toBe(42)
    scopes.clear("A")
    expect(scopes.get("A")).toBeUndefined()
  })

  test("a new search only invalidates its own scope and only the latest version owns the write", () => {
    const scopes = createSearchScopes()
    const a = scopes.begin("A")
    const b = scopes.begin("B")
    // 并行的 A / B 互不作废
    expect(scopes.owns("A", a)).toBe(true)
    expect(scopes.owns("B", b)).toBe(true)
    // A 再发起新搜索：A 的旧响应作废，B 不受影响
    const a2 = scopes.begin("A")
    expect(scopes.owns("A", a)).toBe(false)
    expect(scopes.owns("A", a2)).toBe(true)
    expect(scopes.owns("B", b)).toBe(true)
  })

  test("a stale response after switching away cannot claim ownership again", () => {
    const scopes = createSearchScopes()
    const first = scopes.begin("A")
    // 切走再切回：新一轮搜索登记新版本，旧的迟到响应不得通过
    const again = scopes.begin("A")
    expect(again).not.toBe(first)
    expect(scopes.owns("A", first)).toBe(false)
    expect(scopes.owns("A", again)).toBe(true)
    scopes.clear("A")
    expect(scopes.owns("A", again)).toBe(false)
  })

  test("clear advances the generation so a reused version cannot claim a pending response", () => {
    const scopes = createSearchScopes()
    const pending = scopes.begin("A")
    scopes.clear("A")
    expect(scopes.owns("A", pending)).toBe(false)
    // 清空后重新搜索：不能从 1 重来与在途请求撞号（ABA）
    const next = scopes.begin("A")
    expect(next).not.toBe(pending)
    expect(scopes.owns("A", pending)).toBe(false)
    expect(scopes.owns("A", next)).toBe(true)
  })
})
