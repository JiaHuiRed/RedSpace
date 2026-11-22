import { expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import * as languageContext from "@/context/language"
import * as sdkContext from "@/context/sdk"
import { SessionSearchPanel } from "./turn-outline"

type QueryCall = {
  sessionID: string
  q: string
  resolve: (value: unknown) => void
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
          new Promise((resolve) => calls.push({ sessionID: input.sessionID, q: input.q, resolve })),
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
