import { createSignal } from "solid-js"

// 261122 Red 第一批：时间线定位的忙状态按「发起它的会话」归属。
// 旧实现是一个全局布尔：A 在翻历史时 B 的「返回工具」被吞，A 的 finally 还会把 B 的锁
// 放掉。归属取 (scope, token)，切入新作用域即作废旧操作；切回同一作用域也不会让旧操作
// 复活（全局记忆 #704：只比实体 id 拦不住 A→B→A）。
export type LocateClaim = { scope: string; token: number }

export function createLocateOwnership() {
  const [claim, setClaim] = createSignal<LocateClaim>()
  let token = 0
  return {
    busy: (scope: string) => claim()?.scope === scope,
    /** 当前作用域已有定位在跑时返回 undefined；不同作用域的旧操作直接作废。 */
    begin(scope: string) {
      if (claim()?.scope === scope) return undefined
      const next = { scope, token: ++token }
      setClaim(next)
      return next
    },
    current(candidate: LocateClaim) {
      return claim()?.token === candidate.token
    },
    end(candidate: LocateClaim) {
      if (claim()?.token === candidate.token) setClaim(undefined)
    },
    release() {
      setClaim(undefined)
    },
  }
}
