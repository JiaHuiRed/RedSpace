export const popularProviders = [
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

export const isFreeModel = (providerID: string, cost: { input: number } | undefined) =>
  providerID === "redcode" && (!cost || cost.input === 0)

type RecentModelItem = { recent?: boolean }

/** 全量选择对话框把可见的最近模型排在前面。旧存档可能含重复的最近记录。 */
export function mergeRecentItems<T>(recents: T[], models: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of recents) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }
  return [...out, ...models.filter((model) => !seen.has(key(model)))]
}

/** 分组排序：最近使用恒排最前，其余按常用供应商清单的顺序排。 */
export function sortGroupsRecentFirst<T extends RecentModelItem>(
  providerID: (item: T) => string,
): (a: { items: T[] }, b: { items: T[] }) => number {
  return (a, b) => {
    const aRecent = a.items[0]?.recent === true
    const bRecent = b.items[0]?.recent === true
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    const aID = providerID(a.items[0]!)
    const bID = providerID(b.items[0]!)
    if (popularProviders.includes(aID) && !popularProviders.includes(bID)) return -1
    if (!popularProviders.includes(aID) && popularProviders.includes(bID)) return 1
    return popularProviders.indexOf(aID) - popularProviders.indexOf(bID)
  }
}

/**
 * 261121 Red 供应商飞出层的「最近使用」分组：模型最近记录逐条取供应商 ID，去重保序。
 * 解析不到的条目（模型已下线等）静默跳过——recency 推导不该比主列表更响。
 */
export function recentProviderIDs(recent: readonly ({ provider: { id: string } } | undefined)[]): string[] {
  return [...new Set(recent.flatMap((model) => model ? [model.provider.id] : []))]
}

/** 供应商飞出层的「全部供应商」排序：常用清单在前列表内保持相对顺序，其余按名称。 */
export function popularFirstProviders<P extends { id: string; name: string }>(providers: readonly P[]): P[] {
  const rank = (id: string) => {
    const index = popularProviders.indexOf(id)
    return index === -1 ? popularProviders.length : index
  }
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}
