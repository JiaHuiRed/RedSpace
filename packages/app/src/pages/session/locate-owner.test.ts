import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createLocateOwnership } from "./locate-owner"

describe("locate ownership", () => {
  test("same scope is exclusive while a different scope invalidates the old claim", () => {
    createRoot((dispose) => {
      try {
        const jumping = createLocateOwnership()
        const a = jumping.begin("A")!
        expect(a).toBeDefined()
        expect(jumping.busy("A")).toBe(true)
        expect(jumping.begin("A")).toBeUndefined()

        // 切到 B 时旧操作作废并立即放行；A 的 finally 不能释放 B 的锁
        const b = jumping.begin("B")!
        expect(jumping.busy("A")).toBe(false)
        expect(jumping.busy("B")).toBe(true)
        expect(jumping.current(a)).toBe(false)
        jumping.end(a)
        expect(jumping.current(b)).toBe(true)

        jumping.end(b)
        expect(jumping.busy("B")).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  test("switching away and back cannot revive the old operation", () => {
    createRoot((dispose) => {
      try {
        const jumping = createLocateOwnership()
        const a = jumping.begin("A")!
        // 切会话时调用方 release；切回 A 后新点击立即可用，旧 token 永久失效
        jumping.release()
        const back = jumping.begin("A")!
        expect(back.token).not.toBe(a.token)
        expect(jumping.current(a)).toBe(false)
        expect(jumping.current(back)).toBe(true)
        jumping.end(a)
        expect(jumping.current(back)).toBe(true)
      } finally {
        dispose()
      }
    })
  })
})
