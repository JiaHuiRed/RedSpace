import { expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import * as languageContext from "@/context/language"
import * as sdkContext from "@/context/sdk"
import { SessionSearchPanel } from "./turn-outline"

type QueryCall = {
  sessionID: string
  q: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
const calls: QueryCall[] = []

// 261122 Red 第一批：迟到响应的归属只有渲染级能验——A 的请求在 B 挂载之后才放行，
// A 的结果只能进 A 的缓存与自己的面板，不得改写 B 的输入、命中或运行态。
mock.module("@/context/sdk", () => ({
  ...sdkContext,
  useSDK: () => ({
    url: "http://127.0.0.1:4097",
    directory: "/repo",
    client: {
      session: {
        query: (input: { sessionID: string; q: string }) =>
          new Promise((resolve, reject) =>
            calls.push({ sessionID: input.sessionID, q: input.q, resolve, reject }),
          ),
      },
    },
  }),
}))
mock.module("@/context/language", () => ({
  ...languageContext,
  useLanguage: () => ({ t: (key: string) => key, intl: () => "en" }),
}))

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function mount(scope: string, sessionID: string) {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => <SessionSearchPanel scope={scope} sessionID={sessionID} busy={false} onHit={() => {}} />,
    container,
  )
  return {
    container,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

async function search(container: HTMLElement, text: string) {
  const input = container.querySelector("input") as HTMLInputElement
  input.value = text
  input.dispatchEvent(new Event("input", { bubbles: true }))
  container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await flush()
}

const hit = (id: string, text: string) => ({
  data: { results: [{ messageID: id, partID: `p_${id}`, role: "user", text, createdAt: 1 }], scannedParts: 1 },
})

test("a late response from another scope never lands in the current panel", async () => {
  const a = mount("scope-a\u0000ses_a", "ses_a")
  await search(a.container, "needle-a")
  expect(calls.length).toBe(1)
  expect(calls[0].sessionID).toBe("ses_a")
  a.dispose()

  const b = mount("scope-b\u0000ses_b", "ses_b")
  await search(b.container, "needle-b")
  expect(calls.length).toBe(2)

  // A 的响应在 B 已挂载后才放行
  calls[0].resolve(hit("m_a", "needle-a hit"))
  await flush()
  expect(b.container.textContent).not.toContain("needle-a hit")
  expect((b.container.querySelector("input") as HTMLInputElement).value).toBe("needle-b")

  // B 的响应照常落在 B
  calls[1].resolve(hit("m_b", "needle-b hit"))
  await flush()
  expect(b.container.textContent).toContain("needle-b hit")

  // 切回 A：从 A 自己的缓存恢复迟到写入的关键词与命中（不被 B 覆盖）
  const back = mount("scope-a\u0000ses_a", "ses_a")
  expect((back.container.querySelector("input") as HTMLInputElement).value).toBe("needle-a")
  expect(back.container.textContent).toContain("needle-a hit")
  back.dispose()
  b.dispose()
})

const submitButton = (container: HTMLElement) =>
  container.querySelector('form button[type="submit"]') as HTMLButtonElement

const backToOutline = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("backToOutline"))!

test("returning to the outline while a search is pending releases the panel", async () => {
  const panel = mount("scope-c\u0000ses_c", "ses_c")
  const base = calls.length
  await search(panel.container, "needle-c")
  calls[base].resolve(hit("m_c", "needle-c hit"))
  await flush()
  expect(panel.container.textContent).toContain("needle-c hit")

  // 第二次搜索挂起时点「返回大纲」
  await search(panel.container, "needle-c2")
  expect(calls.length).toBe(base + 2)
  expect(submitButton(panel.container).disabled).toBe(true)
  backToOutline(panel.container).click()
  await flush()

  // 迟到的旧响应既不回写也不卡住运行态
  calls[base + 1].resolve(hit("m_c2", "stale-c2 hit"))
  await flush()
  expect(panel.container.textContent).not.toContain("stale-c2 hit")
  expect(submitButton(panel.container).disabled).toBe(false)

  // 清空后重新搜索能正常发起并落到面板
  await search(panel.container, "needle-c3")
  expect(calls.length).toBe(base + 3)
  calls[base + 2].resolve(hit("m_c3", "needle-c3 hit"))
  await flush()
  expect(panel.container.textContent).toContain("needle-c3 hit")
  panel.dispose()
})

test("a failed new search does not leave old hits under the new keyword", async () => {
  const panel = mount("scope-d\u0000ses_d", "ses_d")
  const base = calls.length
  await search(panel.container, "needle-d")
  calls[base].resolve(hit("m_d", "needle-d hit"))
  await flush()
  expect(panel.container.textContent).toContain("needle-d hit")

  await search(panel.container, "needle-d2")
  calls[base + 1].reject(new Error("boom"))
  await flush()
  expect(panel.container.textContent).not.toContain("needle-d hit")
  expect(panel.container.textContent).toContain("boom")
  panel.dispose()
})
