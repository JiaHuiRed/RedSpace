import { describe, expect, test } from "bun:test"
import { selectCompanion } from "./companion-workspace"

const profiles = [{ id: "qiuqiu", name: "秋秋" }, { id: "karina", name: "Karina" }]

describe("selectCompanion", () => {
  test("takes the explicit companion even when a different one is remembered", () => {
    expect(selectCompanion(profiles, "karina", "qiuqiu")?.id).toBe("karina")
  })

  test("an unknown explicit id stays unresolved so the page can ask the user to pick", () => {
    expect(selectCompanion(profiles, "missing", "qiuqiu")).toBeUndefined()
  })

  test("falls back to the first companion when the remembered id no longer exists", () => {
    // 261123 Red 旧档案 id（companion-<hash>）在迁移成目录名后失效，不能卡死 Chat 首页。
    expect(selectCompanion(profiles, undefined, "companion-10cf9da8b9c0")?.id).toBe("qiuqiu")
  })

  test("keeps the remembered companion when it is still valid", () => {
    expect(selectCompanion(profiles, undefined, "karina")?.id).toBe("karina")
  })

  test("uses the first companion when nothing was ever selected", () => {
    expect(selectCompanion(profiles, undefined, undefined)?.id).toBe("qiuqiu")
  })
})
