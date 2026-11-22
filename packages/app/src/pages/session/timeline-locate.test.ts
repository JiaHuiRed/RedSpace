import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createTimelineLocator,
  findGroupHost,
  findPartHost,
  highlightRanges,
  openGroupTrigger,
  revealWithinHost,
  textMounted,
  toolBodyTrigger,
} from "./timeline-locate"

const toggle = (trigger: HTMLElement, onOpen: () => void) => {
  trigger.addEventListener("click", () => {
    trigger.setAttribute("aria-expanded", "true")
    onOpen()
  })
}

function buildHost(input: { bodyOpen: boolean; text: string }) {
  const host = document.createElement("div")
  host.setAttribute("data-timeline-part-id", "prt_1")

  const collapsible = document.createElement("div")
  collapsible.setAttribute("data-component", "collapsible")
  collapsible.className = "tool-collapsible"
  const body = document.createElement("button")
  body.setAttribute("data-slot", "collapsible-trigger")
  body.setAttribute("aria-expanded", input.bodyOpen ? "true" : "false")
  const content = document.createElement("div")
  content.setAttribute("data-slot", "collapsible-content")
  collapsible.append(body, content)
  host.append(collapsible)
  if (input.bodyOpen) content.textContent = input.text
  toggle(body, () => (content.textContent = input.text))
  return { host, body, content }
}

function addNestedAccordion(container: HTMLElement, text: string) {
  const trigger = document.createElement("button")
  trigger.setAttribute("data-slot", "accordion-trigger")
  trigger.setAttribute("aria-expanded", "false")
  const item = document.createElement("div")
  item.setAttribute("data-slot", "accordion-item")
  item.append(trigger)
  container.append(item)
  let clicks = 0
  trigger.addEventListener("click", () => {
    clicks += 1
    trigger.setAttribute("aria-expanded", "true")
    item.append(document.createTextNode(text))
  })
  return { trigger, clicks: () => clicks }
}

const frame = () => Promise.resolve()

function setupLocator(options: {
  frame?: () => Promise<void>
  usingNative?: boolean
  scrollToVirtualRow?: (kind: "message" | "part", id: string) => void
} = {}) {
  return createRoot((dispose) => {
    const root = document.createElement("div")
    const [sessionKey, setSession] = createSignal("a")
    const locator = createTimelineLocator({
      root: () => root,
      sessionKey,
      anchor: (id) => id,
      usingNative: () => options.usingNative ?? false,
      onReveal: () => {},
      scrollToVirtualRow: options.scrollToVirtualRow ?? (() => {}),
    }, options.frame ?? frame)
    return { root, dispose, setSession, ...locator }
  })
}

describe("timeline locator", () => {
  test("asks the renderer again for a late row, then opens the tool group and body once", async () => {
    const target = { messageID: "msg", partID: "prt_1", query: "needle" }
    const { host } = buildHost({ bodyOpen: false, text: "needle" })
    const group = document.createElement("div")
    group.dataset.timelinePartIds = "prt_1"
    const trigger = document.createElement("button")
    trigger.dataset.component = "context-tool-group-trigger"
    group.append(trigger)
    let opens = 0
    trigger.addEventListener("click", () => {
      opens++
      group.append(host)
    })

    const calls: string[] = []
    const locator = setupLocator({
      scrollToVirtualRow: (kind, id) => {
        calls.push(`${kind}:${id}`)
        if (calls.length === 3) locator.root.append(group)
      },
    })
    try {
      locator.revealMessage(target.messageID)
      expect(await locator.revealPart(target)).toBe(true)
      expect(calls).toEqual(["message:msg", "part:prt_1", "part:prt_1"])
      expect(opens).toBe(1)
      expect(host.textContent).toBe("needle")
    } finally {
      locator.dispose()
    }
  })

  test("reports a missing search hit but restores the saved scroll position on return", async () => {
    const locator = setupLocator()
    const target = { messageID: "msg", partID: "missing" }
    try {
      locator.root.scrollTop = 70
      expect(await locator.revealPart({ ...target, query: "lost" })).toBe(false)
      expect(locator.root.scrollTop).toBe(70)
      expect(await locator.revealPart({ ...target, scrollTop: 0 })).toBe(true)
      expect(locator.root.scrollTop).toBe(0)
    } finally {
      locator.dispose()
    }
  })

  test("a session switch and switch back invalidates pending part work", async () => {
    const locator = setupLocator()
    const { host, body } = buildHost({ bodyOpen: false, text: "needle" })
    try {
      locator.root.scrollTop = 70
      const pending = locator.revealPart({ messageID: "msg", partID: "prt_1", scrollTop: 0 })
      locator.setSession("b")
      locator.setSession("a")
      locator.root.append(host)
      expect(await pending).toBe(false)
      expect(body.getAttribute("aria-expanded")).toBe("false")
      expect(locator.root.scrollTop).toBe(70)
    } finally {
      locator.dispose()
    }
  })

  test("unmount stops an in-flight body reveal before it scrolls or restores a snapshot", async () => {
    const locator = setupLocator()
    const { host } = buildHost({ bodyOpen: false, text: "needle" })
    locator.root.append(host)
    locator.root.scrollTop = 70
    const pending = locator.revealPart({ messageID: "msg", partID: "prt_1", scrollTop: 0 })
    locator.dispose()
    expect(await pending).toBe(false)
    expect(locator.root.scrollTop).toBe(70)
  })

  test("native message and part jumps use the scroll root, not the virtual renderer", async () => {
    const calls: string[] = []
    const locator = setupLocator({ usingNative: true, scrollToVirtualRow: (kind) => calls.push(kind) })
    const { host } = buildHost({ bodyOpen: true, text: "needle" })
    host.id = "msg"
    locator.root.append(host)
    document.body.append(locator.root)
    try {
      locator.root.scrollTop = 60
      locator.revealMessage("msg")
      expect(locator.root.scrollTop).toBe(60)
      expect(await locator.revealPart({ messageID: "msg", partID: "prt_1", query: "needle" })).toBe(true)
      expect(locator.root.scrollTop).toBe(48)
      expect(calls).toEqual([])
    } finally {
      locator.root.remove()
      locator.dispose()
    }
  })
})

describe("revealWithinHost", () => {
  test("expands the tool body when the group is already open but the item is collapsed", async () => {
    const { host } = buildHost({ bodyOpen: false, text: "needle in tool output" })
    let found = 0

    const located = await revealWithinHost({ host: () => host, query: "needle", frame, onFound: () => found++ })

    expect(located).toBe(true)
    expect(found).toBe(1)
    expect(host.textContent).toContain("needle in tool output")
    expect(textMounted(host, "needle")).toBe(true)
  })

  test("keeps opening inner collapsed items until the hit text is actually mounted", async () => {
    const { host, body } = buildHost({ bodyOpen: true, text: "outer body" })
    const nested = addNestedAccordion(host.querySelector('[data-slot="collapsible-content"]')!, "deep needle")

    const located = await revealWithinHost({ host: () => host, query: "deep needle", frame })

    expect(located).toBe(true)
    expect(nested.clicks()).toBe(1)
    expect(body.getAttribute("aria-expanded")).toBe("true")
    expect(host.textContent).toContain("deep needle")
  })

  test("return-to-tool path (no query) expands only the tool body and leaves inner items collapsed", async () => {
    const { host, content } = buildHost({ bodyOpen: false, text: "tool body" })
    const nested = addNestedAccordion(content, "inner details")

    const located = await revealWithinHost({ host: () => host, frame })

    expect(located).toBe(true)
    expect(content.textContent).toContain("tool body")
    expect(nested.clicks()).toBe(0)
    expect(nested.trigger.getAttribute("aria-expanded")).toBe("false")
  })

  test("reports failure when the hit text never mounts", async () => {
    const { host } = buildHost({ bodyOpen: false, text: "unrelated output" })

    const located = await revealWithinHost({ host: () => host, query: "missing needle", frame })

    expect(located).toBe(false)
    expect(textMounted(host, "missing needle")).toBe(false)
  })

  test("waits for asynchronously mounted tool output after opening its body", async () => {
    const { host, content } = buildHost({ bodyOpen: false, text: "" })
    let frames = 0
    const located = await revealWithinHost({
      host: () => host,
      query: "late output",
      frame: async () => {
        if (++frames === 3) content.textContent = "late output"
      },
    })
    expect(located).toBe(true)
    expect(frames).toBe(3)
  })
})

describe("timeline locate selectors", () => {
  test("finds the part and its tool group by id", () => {
    const root = document.createElement("div")
    root.innerHTML = `
      <div data-timeline-part-ids="a,b">
        <button data-component="context-tool-group-trigger"></button>
        <div data-timeline-part-id="b"></div>
      </div>`

    const group = findGroupHost(root, "b")
    expect(group).toBeDefined()
    openGroupTrigger(group!)
    expect(findPartHost(root, "b")?.dataset.timelinePartId).toBe("b")
    expect(findPartHost(root, "zzz")).toBeUndefined()
  })

  test("toolBodyTrigger skips non-tool collapsibles", () => {
    const host = document.createElement("div")
    host.innerHTML = `<div data-component="collapsible"><button data-slot="collapsible-trigger"></button></div>`
    expect(toolBodyTrigger(host)).toBeUndefined()
  })
})

describe("highlightRanges", () => {
  test("matches a literal across text nodes split by syntax highlighting", () => {
    const host = document.createElement("div")
    host.innerHTML = `<span>git</span><span> status</span>`
    const ranges = highlightRanges(host, "git status")
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.toString()).toBe("git status")
  })

  test("keeps separate ranges for repeated matches in one node", () => {
    const host = document.createElement("div")
    host.textContent = "needle and needle"
    const ranges = highlightRanges(host, "needle")
    expect(ranges).toHaveLength(2)
    expect(ranges.map((range) => range.toString())).toEqual(["needle", "needle"])
  })

  test("does not join toolbar text with body text into one match", () => {
    const host = document.createElement("div")
    const trigger = document.createElement("button")
    trigger.textContent = "git"
    const body = document.createElement("div")
    body.textContent = " status"
    host.append(trigger, body)
    expect(highlightRanges(host, "git status")).toHaveLength(0)
    expect(highlightRanges(host, "status")).toHaveLength(1)
  })
})
