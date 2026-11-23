import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { codeSoulKeys, resolveCachedCodeSoul, resolveCodeSoul } from "./soul-identity"

function makeClient(input: {
  souls?: Array<{ id: string }>
  companions?: Array<{ soulID: string }>
  serverDefault?: string
}) {
  const calls = { list: 0, companions: 0, default: 0 }
  return {
    calls,
    client: {
      soul: {
        list: async () => {
          calls.list += 1
          return { data: input.souls ?? [] }
        },
        default: async () => {
          calls.default += 1
          return { data: { id: input.serverDefault ?? "" } }
        },
      },
      companion: {
        list: async () => {
          calls.companions += 1
          return { data: input.companions ?? [] }
        },
      },
    },
  }
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })

describe("resolveCodeSoul", () => {
  test("an already confirmed identity creates the session without any identity query", async () => {
    const { calls, client } = makeClient({ souls: [{ id: "karina" }] })
    const soul = await resolveCodeSoul(newClient(), { client, url: "u", saved: "karina", confirmed: "karina" })
    expect(soul).toBe("karina")
    expect(calls).toEqual({ list: 0, companions: 0, default: 0 })
  })

  test("waits for the desktop default only when the saved identity is not eligible", async () => {
    const { calls, client } = makeClient({
      souls: [{ id: "karina" }, { id: "yuqi" }],
      companions: [{ soulID: "karina" }],
      serverDefault: "yuqi",
    })
    const soul = await resolveCodeSoul(newClient(), { client, url: "u", saved: "karina" })
    expect(soul).toBe("yuqi")
    expect(calls.default).toBe(1)
  })

  test("does not wait for the desktop default when the saved identity is eligible", async () => {
    const { calls, client } = makeClient({
      souls: [{ id: "karina" }, { id: "yuqi" }],
      companions: [{ soulID: "yuqi" }],
    })
    const soul = await resolveCodeSoul(newClient(), { client, url: "u", saved: "karina" })
    expect(soul).toBe("karina")
    expect(calls).toEqual({ list: 1, companions: 1, default: 0 })
  })

  test("shares the loaded identity cache with the session page", async () => {
    const queryClient = newClient()
    const { calls, client } = makeClient({ souls: [{ id: "karina" }, { id: "yuqi" }], serverDefault: "karina" })
    queryClient.setQueryData(codeSoulKeys("u").list, [{ id: "karina" }, { id: "yuqi" }])
    queryClient.setQueryData(codeSoulKeys("u").companions, [])
    const soul = await resolveCodeSoul(queryClient, { client, url: "u", saved: "" })
    expect(soul).toBe("karina")
    expect(calls).toEqual({ list: 0, companions: 0, default: 1 })
  })
})

describe("resolveCachedCodeSoul", () => {
  test("returns undefined until both lists are cached", () => {
    const queryClient = newClient()
    const keys = codeSoulKeys("u")
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBeUndefined()
    queryClient.setQueryData(keys.list, [{ id: "karina" }])
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBeUndefined()
    queryClient.setQueryData(keys.companions, [])
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBe("karina")
  })

  test("does not guess the first identity while the desktop default is still unknown", () => {
    const queryClient = newClient()
    const keys = codeSoulKeys("u")
    queryClient.setQueryData(keys.list, [{ id: "karina" }, { id: "yuqi" }])
    queryClient.setQueryData(keys.companions, [{ soulID: "karina" }])
    // saved 已被绑走、默认值未落缓存：不能用第一个可用 Soul 顶替，必须交给提交路径去取
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBeUndefined()
  })

  test("uses the cached desktop default instead of the first eligible identity", () => {
    const queryClient = newClient()
    const keys = codeSoulKeys("u")
    queryClient.setQueryData(keys.list, [{ id: "karina" }, { id: "yuqi" }])
    queryClient.setQueryData(keys.companions, [{ soulID: "karina" }])
    queryClient.setQueryData(keys.desktopDefault, { id: "yuqi" })
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBe("yuqi")
  })

  test("falls back to the first eligible identity once the desktop default is known to be empty", () => {
    const queryClient = newClient()
    const keys = codeSoulKeys("u")
    queryClient.setQueryData(keys.list, [{ id: "karina" }, { id: "yuqi" }])
    queryClient.setQueryData(keys.companions, [{ soulID: "karina" }])
    queryClient.setQueryData(keys.desktopDefault, { id: "" })
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBe("yuqi")
  })

  test("an eligible saved identity still resolves without the desktop default", () => {
    const queryClient = newClient()
    const keys = codeSoulKeys("u")
    queryClient.setQueryData(keys.list, [{ id: "karina" }, { id: "yuqi" }])
    queryClient.setQueryData(keys.companions, [{ soulID: "yuqi" }])
    expect(resolveCachedCodeSoul(queryClient, { url: "u", saved: "karina" })).toBe("karina")
  })
})
