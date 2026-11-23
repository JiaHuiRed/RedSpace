import type { QueryClient } from "@tanstack/solid-query"
import { chooseCodeSoul } from "@/utils/code-soul"

// 261122 Red 第二批：Code Soul 身份查询的唯一入口。新会话页与发送入口以前各自拼
// queryKey，默认接口还绕过缓存直连——暖态首发仍要等一次往返。这里统一键与取数，
// 两边共享同一份缓存，fetchQuery 也会并进已在途的请求。
// 只声明用到的方法，测试的替身客户端也满足同一契约。
export type SoulIdentityClient = {
  soul: {
    list(input: { throwOnError: true }): Promise<{ data: ReadonlyArray<{ id: string }> }>
    default(input: { client: "desktop" }, options: { throwOnError: true }): Promise<{ data: { id?: string } }>
  }
  companion: {
    list(input: { throwOnError: true }): Promise<{ data: ReadonlyArray<{ soulID: string }> }>
  }
}

export const codeSoulKeys = (url: string) => ({
  list: ["soul", url, "list"] as const,
  companions: ["companion", url, "list"] as const,
  desktopDefault: ["soul", url, "default", "desktop"] as const,
})

export function codeSoulQueries(client: SoulIdentityClient, url: string) {
  const keys = codeSoulKeys(url)
  return {
    list: {
      queryKey: keys.list,
      queryFn: async () => (await client.soul.list({ throwOnError: true })).data,
    },
    companions: {
      queryKey: keys.companions,
      queryFn: async () => (await client.companion.list({ throwOnError: true })).data,
    },
    desktopDefault: {
      queryKey: keys.desktopDefault,
      queryFn: async () => (await client.soul.default({ client: "desktop" }, { throwOnError: true })).data,
    },
  }
}

/** 只读已加载的缓存解析身份；决定身份所需的数据不全时返回 undefined，交给提交路径按需取数。 */
export function resolveCachedCodeSoul(queryClient: QueryClient, input: { url: string; saved?: string }) {
  const keys = codeSoulKeys(input.url)
  const souls = queryClient.getQueryData<ReadonlyArray<{ id: string }>>(keys.list)
  const companions = queryClient.getQueryData<ReadonlyArray<{ soulID: string }>>(keys.companions)
  if (!souls || !companions) return undefined
  const bound = new Set(companions.map((profile) => profile.soulID))
  const savedEligible = !!input.saved && souls.some((soul) => soul.id === input.saved) && !bound.has(input.saved)
  const desktopDefault = queryClient.getQueryState<{ id?: string }>(keys.desktopDefault)
  // 261123 Red 没有有效 saved 时，默认值还没落缓存就不能拿「第一个可用 Soul」顶替：
  // 服务端配置的默认可能另有其人，快速提交会建出错误身份。返回 undefined 让提交路径去取。
  if (!savedEligible && !desktopDefault) return undefined
  return chooseCodeSoul({
    saved: input.saved,
    serverDefault: desktopDefault?.data?.id,
    souls,
    companions,
  })
}

/**
 * 解析这次提交该用哪个 Code Soul：已确认的直接返回（零查询）；否则只等决定身份所缺的
 * 数据——已加载的列表直接读缓存，saved 在可用列表里有效时不再等桌面默认值。
 * 选择顺序仍由 chooseCodeSoul 决定。
 */
export async function resolveCodeSoul(
  queryClient: QueryClient,
  input: { client: SoulIdentityClient; url: string; saved?: string; confirmed?: string },
) {
  if (input.confirmed) return input.confirmed
  const queries = codeSoulQueries(input.client, input.url)
  const cachedSouls = queryClient.getQueryData<ReadonlyArray<{ id: string }>>(queries.list.queryKey)
  const cachedCompanions = queryClient.getQueryData<ReadonlyArray<{ soulID: string }>>(queries.companions.queryKey)
  const [souls, companions] =
    cachedSouls && cachedCompanions
      ? [cachedSouls, cachedCompanions]
      : await Promise.all([
          cachedSouls ?? queryClient.fetchQuery(queries.list),
          cachedCompanions ?? queryClient.fetchQuery(queries.companions),
        ])
  const bound = new Set(companions.map((profile) => profile.soulID))
  if (input.saved && souls.some((soul) => soul.id === input.saved) && !bound.has(input.saved)) return input.saved
  const serverDefault =
    queryClient.getQueryData<{ id?: string }>(queries.desktopDefault.queryKey) ?? (await queryClient.fetchQuery(queries.desktopDefault))
  return chooseCodeSoul({ saved: input.saved, serverDefault: serverDefault?.id, souls, companions })
}
