// 261116 Red B05/B06：时间线定位生命周期与 DOM 观察。
//
// 搜索命中落在工具输出里时，时间线只展开到「工具组」还不够：组内每个工具自己的
// BasicTool 折叠默认是收起的，未挂载的 output 没有 textNode，既定位不到也高亮不了。
// 这里按「已挂载的 DOM 状态」逐层点开目标片段内部的折叠（collapsible / accordion），
// 每轮用 textContent 观测命中词是否真的出现，命中即停；只作用于目标片段，不全展开整组。
// 不假设「等一帧 DOM 就好」——每一轮都重新读取状态，帧数/展开次数都有上限。
// 决策：docs/notes/implemented/feature/2026-11-16-experience-roadmap-v2.md

import { createComputed, on, onCleanup } from "solid-js"

export type RevealTarget = {
  messageID: string
  partID?: string
  userMessageID?: string
  /** 命中消息/cited 消息的 time.created；窗口外定位用它选翻页方向。 */
  createdAt?: number
  /** 命中词（后端语义：字面、大小写敏感），用于在正文/工具内容上高亮。 */
  query?: string
  /** 片段找不到时恢复的阅读位置（B06 返回工具）。 */
  scrollTop?: number
}

export type TimelineLocator = ReturnType<typeof createTimelineLocator>

export function createTimelineLocator(
  input: {
    root: () => HTMLElement | undefined
    sessionKey: () => string
    anchor: (id: string) => string
    usingNative: () => boolean
    scrollToVirtualRow: (kind: "message" | "part", id: string) => void
    onReveal: () => void
  },
  frame = nextFrame,
) {
  let generation = 0
  let disposed = false
  let highlightStyle: HTMLStyleElement | undefined
  const clearHighlight = () => highlightRegistry()?.delete(LOCATE_HIGHLIGHT)

  createComputed(
    on(
      input.sessionKey,
      () => {
        generation++
        clearHighlight()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    disposed = true
    clearHighlight()
    highlightStyle?.remove()
  })

  const revealMessage = (id: string) => {
    if (disposed) return
    input.onReveal()
    if (!input.usingNative()) {
      input.scrollToVirtualRow("message", id)
      return
    }
    const root = input.root()
    const target = root?.ownerDocument.getElementById(input.anchor(id))
    if (root && target && root.contains(target)) scrollIntoView(root, target)
  }

  const revealPart = async (target: RevealTarget) => {
    const { partID } = target
    const root = input.root()
    if (disposed || !partID || !root) return false
    const started = generation
    const isCurrent = () => !disposed && generation === started && input.root() === root
    const mountRow = () => {
      if (!input.usingNative()) input.scrollToVirtualRow("part", partID)
    }
    const fallback = () => {
      if (!isCurrent()) return false
      clearHighlight()
      if (target.scrollTop === undefined) return false
      root.scrollTop = target.scrollTop
      return true
    }

    input.onReveal()
    mountRow()
    let groupOpened = false
    let host: HTMLElement | undefined
    // 261117 Red 40 帧在 2 核 CI 上不够等虚拟行挂载；放宽到 120 帧，每 12 帧补滚一次。
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!isCurrent()) return false
      host = findPartHost(root, partID)
      if (host) break
      if (!groupOpened) {
        const group = findGroupHost(root, partID)
        if (group) groupOpened = openGroupTrigger(group)
      }
      await frame()
      if (isCurrent() && attempt % 12 === 11) mountRow()
    }
    if (!host) return fallback()

    const located = await revealWithinHost({
      host: () => {
        if (host && root.contains(host)) return host
        host = findPartHost(root, partID)
        return host
      },
      query: target.query,
      frame,
      isCurrent,
      onFound: (found) => {
        scrollIntoView(root, found, 12)
        clearHighlight()
        const registry = highlightRegistry()
        const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
        if (!target.query || !registry || !Highlight) return
        const ranges = highlightRanges(found, target.query)
        if (!ranges.length) return
        if (!highlightStyle?.isConnected) {
          highlightStyle = root.ownerDocument.createElement("style")
          highlightStyle.textContent = `::highlight(${LOCATE_HIGHLIGHT}){background-color:rgba(235,175,45,0.45);color:inherit}`
          root.ownerDocument.head.append(highlightStyle)
        }
        registry.set(LOCATE_HIGHLIGHT, new Highlight(...ranges))
      },
    })
    return located || fallback()
  }

  return { revealMessage, revealPart }
}

function scrollIntoView(root: HTMLElement, target: HTMLElement, padding = 0) {
  const sticky = root.querySelector<HTMLElement>("[data-session-title]")
  const delta = target.getBoundingClientRect().top - root.getBoundingClientRect().top
  root.scrollTo({ top: Math.max(0, root.scrollTop + delta - (sticky?.offsetHeight ?? 0) - padding), behavior: "auto" })
}

const LOCATE_HIGHLIGHT = "redcode-locate"
type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void }
const highlightRegistry = () => (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights

// 与后端搜索同为字面、区分大小写的子串；不改写 Solid 管理的正文。
// 261122 Red 第三批：跨文本节点匹配。语法着色会把一段文本拆成多个 span，逐节点
// indexOf 找不到 "git" + " status" 这类跨节点字面量。先在按文档序拼接的文本里定位，
// 再把区间映射回首尾文本节点（Range 的起止可以落在不同节点上）。
export function highlightRanges(host: HTMLElement, query: string) {
  if (!query) return []
  const doc = host.ownerDocument
  const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ""
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // 261122 Red 第三批：工具操作栏（折叠 trigger、按钮）与正文之间插入分隔符，
    // 避免把「Read」+「 file.ts」这种跨区域的文字拼成一次假命中。
    if (controlText(node)) {
      text += "\u0000"
      continue
    }
    const value = node.nodeValue ?? ""
    // 空节点不占区间，跳过才能保证 starts 严格递增、二分可靠
    if (!value) continue
    nodes.push(node as Text)
    starts.push(text.length)
    text += value
  }
  // 找到覆盖 index 的节点下标（starts 严格递增，二分）
  const nodeAt = (index: number) => {
    let low = 0
    let high = nodes.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const start = starts[mid]!
      const length = nodes[mid]!.nodeValue?.length ?? 0
      if (index < start) high = mid - 1
      else if (index >= start + length) low = mid + 1
      else return mid
    }
    return -1
  }
  const rangeFor = (from: number, to: number) => {
    const first = nodeAt(from)
    const last = nodeAt(to - 1)
    if (first < 0 || last < 0) return undefined
    const range = doc.createRange()
    range.setStart(nodes[first]!, from - starts[first]!)
    range.setEnd(nodes[last]!, to - starts[last]!)
    return range
  }
  const ranges: Range[] = []
  for (let cursor = 0; ranges.length < 200; ) {
    const index = text.indexOf(query, cursor)
    if (index === -1) break
    const range = rangeFor(index, index + query.length)
    if (!range) break
    ranges.push(range)
    cursor = index + query.length
  }
  return ranges
}

const controlText = (node: Node) =>
  !!node.parentElement?.closest(
    'button, [data-slot="collapsible-trigger"], [data-slot="accordion-trigger"], [data-component="context-tool-group-trigger"]',
  )

export const findPartHost = (root: ParentNode, partID: string) => {
  for (const el of root.querySelectorAll<HTMLElement>("[data-timeline-part-id]")) {
    if (el.dataset.timelinePartId === partID) return el
  }
}

export const findGroupHost = (root: ParentNode, partID: string) => {
  for (const el of root.querySelectorAll<HTMLElement>("[data-timeline-part-ids]")) {
    if ((el.dataset.timelinePartIds ?? "").split(",").includes(partID)) return el
  }
}

/** 展开工具组；返回是否找到了组（已展开也算找到）。 */
export const openGroupTrigger = (group: HTMLElement) => {
  if (group.querySelector('[data-component="context-tool-group-list"]')) return true
  const trigger = group.querySelector<HTMLElement>('[data-component="context-tool-group-trigger"]')
  if (!trigger) return false
  trigger.click()
  return true
}

/** 目标工具自身的折叠根（BasicTool 的 tool-collapsible）。 */
export const toolBodyTrigger = (host: HTMLElement) => {
  const body = host.querySelector<HTMLElement>('[data-component="collapsible"].tool-collapsible')
  return body?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
}

/** 片段内部仍未展开的折叠触发器；链接型触发器（task/文件入口）不点，避免导航。 */
export const collapsedTriggers = (host: HTMLElement) => {
  const result: HTMLElement[] = []
  for (const el of host.querySelectorAll<HTMLElement>(
    '[data-slot="collapsible-trigger"], [data-slot="accordion-trigger"]',
  )) {
    if (el.tagName === "A") continue
    if (el.getAttribute("aria-expanded") === "true") continue
    result.push(el)
  }
  return result
}

/** 命中词是否已出现在真实正文里；换行/空白差异按折叠后比较。 */
export const textMounted = (host: HTMLElement, query?: string) => {
  if (!query) return true
  const text = host.textContent ?? ""
  if (text.includes(query)) return true
  return text.replace(/\s+/g, " ").includes(query.replace(/\s+/g, " "))
}

const expanded = (trigger: HTMLElement) =>
  trigger.getAttribute("aria-expanded") === "true" || trigger.tagName === "A"

export type RevealWithinHostInput = {
  host: () => HTMLElement | undefined
  query?: string
  frame: () => Promise<void>
  isCurrent?: () => boolean
  onFound?: (host: HTMLElement) => void
  maxFrames?: number
  maxExpands?: number
}

/**
 * 在目标片段内按需展开，直到命中词出现在已挂载正文里（无命中词时只展开工具自身正文，
 * 供 B06「返回工具」恢复阅读现场）。返回是否找到并展开了目标内容。
 */
export async function revealWithinHost(input: RevealWithinHostInput) {
  const clicked = new Set<HTMLElement>()
  let expands = 0
  const maxFrames = input.maxFrames ?? 90
  const maxExpands = input.maxExpands ?? 12
  for (let frame = 0; frame < maxFrames; frame++) {
    if (input.isCurrent?.() === false) return false
    const host = input.host()
    if (!host) {
      await input.frame()
      continue
    }

    // ① 目标工具自身的正文折叠：命中/返回都要按需展开一次。
    const body = toolBodyTrigger(host)
    if (body && !clicked.has(body) && !expanded(body)) {
      clicked.add(body)
      expands += 1
      body.click()
      await input.frame()
      continue
    }

    // ② 有命中词时继续点开内层折叠（如 apply_patch 的单文件项），命中即停。
    if (input.query && !textMounted(host, input.query) && expands < maxExpands) {
      const next = collapsedTriggers(host).find((el) => !clicked.has(el))
      if (next) {
        clicked.add(next)
        expands += 1
        next.click()
        await input.frame()
        continue
      }
    }

    if (!textMounted(host, input.query)) {
      await input.frame()
      continue
    }
    input.onFound?.(host)
    return true
  }
  return false
}

/** rAF 观测一拍；窗口被遮挡时 rAF 不回调，用等长兜底避免跳转锁死。 */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    let settled = false
    let frame: number
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (settled) return
      settled = true
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      resolve()
    }
    frame = requestAnimationFrame(finish)
    timer = setTimeout(finish, 120)
  })
