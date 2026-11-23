import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture } from "./session-timeline.fixture"

const homeEntry = `/${base64Encode(fixture.directory)}/session`
const newSession = { ...fixture.sessions[0]!, id: "ses_home_first", title: "First from the workspace" }

test("Code workspace puts the composer beside usage and caps only unfiltered idle cards", async ({ page }) => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    ...fixture.sessions[0]!,
    id: `ses_home_card_${String(index).padStart(2, "0")}`,
    title: `Code task ${String(index).padStart(2, "0")}`,
    time: { created: 1700000000000 + index, updated: 1700000000000 + index },
  }))
  await page.addInitScript((directory) => {
    localStorage.setItem("RedCode.global.dat:server", JSON.stringify({
      projects: { local: [{ worktree: directory, expanded: true }] },
    }))
  }, fixture.directory)
  await mockRedCodeServer(page, { ...fixture, sessions, pageMessages: () => ({ items: [] }) })
  const created: unknown[] = []
  const sent: unknown[] = []
  const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
  await page.route((url) => url.port === serverPort, async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === "/experimental/session") return route.fulfill({ json: sessions })
    if (path === "/session" && route.request().method() === "POST") {
      created.push(route.request().postDataJSON())
      sessions.push(newSession)
      return route.fulfill({ json: newSession })
    }
    if (path === `/session/${newSession.id}/prompt_async`) {
      sent.push(route.request().postDataJSON())
      return route.fulfill({ status: 204 })
    }
    if (path === "/config/providers") {
      const directory = url.searchParams.get("directory")
      return route.fulfill({ json: directory ? { providers: fixture.provider.all } : { providers: [] } })
    }
    if (path === "/companion") return route.fulfill({ json: [] })
    return route.fallback()
  })
  await page.goto("/")
  const composer = page.locator('[data-component="home-compose-section"]')
  const board = page.locator('[data-component="home-board-section"]')
  const editor = composer.getByRole("textbox")
  await expect(editor).toBeVisible()
  // 261124 YuQi 布局重排：usage 与 compose 并排在顶部左列，不再属于 board-section。
  await expect(page.locator('[data-frost-surface="home-usage"]')).toBeVisible()
  expect(await composer.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
    await board.evaluate((el) => el.getBoundingClientRect().top),
  )
  const cards = board.locator('[data-component="kanban-card"]')
  await expect(cards).toHaveCount(9)
  await expect(cards.first()).toContainText("Code task 11")
  const search = page.getByRole("textbox", { name: "Search sessions" })
  await search.fill("Code task 00")
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText("Code task 00")
  await search.clear()
  await expect(page).toHaveURL(/\/$/)
  expect(created).toHaveLength(0)
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Claude Opus 4.6")
  await editor.pressSequentially("First from the workspace")
  await expect(editor).toHaveText("First from the workspace")
  await editor.press("Enter")
  await expect.poll(() => sent.length).toBe(1)
  expect(created).toHaveLength(1)
  await expect(page).toHaveURL(new RegExp(`${homeEntry}/${newSession.id}$`))
  await expect(page.locator('[data-component="session-prompt-dock"] [data-component="prompt-input"]')).toBeVisible()
})

test("the old new-session URL opens the same workspace and preserves its deep-link prompt", async ({ page }) => {
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route("**/companion", (route) => route.fulfill({ json: [] }))
  await page.goto(`${homeEntry}?prompt=Carry%20this%20draft`)
  await expect(page.locator('[data-component="home-compose-section"] [data-component="prompt-input"]')).toHaveText("Carry this draft")
  await expect(page.locator('[data-component="home-board-section"]')).toBeVisible()
})

// 261123 Red RS-0204-04：列宽此前固定 355/720 + shrink-0，父列 max-w-full 缩窄时溢出，
// 窄窗口要横向滚才能看全看板。这里在 1024/900 两个视口上直接量几何：文档不出现横向
// 滚动，看板根元素的左右边缘都落在视口内。
for (const width of [1024, 900]) {
  test(`the kanban band fits a ${width}px viewport without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      ...fixture.sessions[0]!,
      id: `ses_home_narrow_${index}`,
      title: `Narrow task ${index}`,
      time: { created: 1700000000000 + index, updated: 1700000000000 + index },
    }))
    await page.addInitScript((directory) => {
      localStorage.setItem("RedCode.global.dat:server", JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
      }))
    }, fixture.directory)
    await mockRedCodeServer(page, { ...fixture, sessions, pageMessages: () => ({ items: [] }) })
    const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    await page.route((url) => url.port === serverPort, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/experimental/session") return route.fulfill({ json: sessions })
      if (url.pathname === "/config/providers") {
        const directory = url.searchParams.get("directory")
        return route.fulfill({ json: directory ? { providers: fixture.provider.all } : { providers: [] } })
      }
      if (url.pathname === "/companion") return route.fulfill({ json: [] })
      return route.fallback()
    })
    await page.goto("/")
    const board = page.locator('[data-component="home-board-section"]')
    await expect(board.locator('[data-component="kanban-card"]').first()).toBeVisible()
    const view = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(view.scroll).toBeLessThanOrEqual(view.client)
    // 看板根不能比父容器宽：固定 355/720 + shrink-0 时这里会超出（负向对照实测 728 > 718）。
    const fit = await board.locator('[data-component="home-kanban"]').evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { width: box.width, parent: el.parentElement!.clientWidth, left: box.left, right: box.right }
    })
    expect(fit.width).toBeLessThanOrEqual(fit.parent)
    expect(fit.left).toBeGreaterThanOrEqual(0)
    expect(fit.right).toBeLessThanOrEqual(view.client)
  })
}

for (const selectLinked of [false, true]) {
  test(`linked-session plus restores its own draft and sends to ${selectLinked ? "linked worktree" : "main"}`, async ({ page }) => {
    const linked = "C:/RedCode/SmokeLinkedWorktree"
    const dirSlug = base64Encode(linked)
    const linkedSession = { ...fixture.sessions[0]!, directory: linked }
    const sessions = [linkedSession]
    const worktreeEntry = `/${dirSlug}/session`
    await page.addInitScript(({ root, linked }) => {
      if (localStorage.getItem("draft-scope-seeded")) return
      localStorage.setItem("draft-scope-seeded", "true")
      localStorage.setItem("RedCode.global.dat:server", JSON.stringify({
        projects: { local: [{ worktree: root, expanded: true }] },
      }))
      for (const [key, content] of [[root, "Root draft"], [linked, "Linked draft"]]) {
        const slug = btoa(key).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
        localStorage.setItem(`${slug}/prompt.v2`, JSON.stringify({
          prompt: [{ type: "text", content, start: 0, end: content.length }],
          cursor: content.length,
          context: { items: [] },
        }))
      }
    }, { root: fixture.directory, linked })
    await mockRedCodeServer(page, {
      ...fixture,
      project: { ...fixture.project, sandboxes: [linked] },
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    const created: string[] = []
    const target = selectLinked ? linked : fixture.directory
    const session = { ...newSession, directory: target }
    const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    await page.route((url) => url.port === serverPort, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/path") {
        const directory = url.searchParams.get("directory") ?? fixture.directory
        return route.fulfill({ json: { state: directory, config: directory, worktree: fixture.directory, directory, home: "C:/RedCode" } })
      }
      if (url.pathname === "/experimental/session") return route.fulfill({ json: sessions })
      if (url.pathname === "/session" && route.request().method() === "POST") {
        created.push(decodeURIComponent(route.request().headers()["x-redcode-directory"] ?? ""))
        sessions.push(session)
        return route.fulfill({ json: session })
      }
      if (url.pathname === `/session/${session.id}/prompt_async`) return route.fulfill({ status: 204 })
      if (url.pathname === "/config/providers") return route.fulfill({ json: { providers: fixture.provider.all } })
      if (url.pathname === "/companion") return route.fulfill({ json: [] })
      return route.fallback()
    })
    // 261123 YuQi 顶栏「+」已下线，直接进旧新建会话 URL（现渲染首页 compose）验证草稿作用域。
    await page.goto(worktreeEntry)
    const composer = page.locator('[data-component="home-compose-section"]')
    const editor = composer.getByRole("textbox")
    await expect(editor).toHaveText("Linked draft")
    const workspace = composer.locator('[data-action="prompt-workspace"]')
    await expect(workspace).toHaveText("main")
    if (selectLinked) {
      await workspace.click()
      await page.getByRole("option", { name: "SmokeLinkedWorktree" }).click()
      await expect(workspace).toHaveText("SmokeLinkedWorktree")
    } else {
      await workspace.click()
      await page.getByRole("option", { name: "SmokeLinkedWorktree" }).click()
      await workspace.click()
      await page.getByRole("option", { name: "main", exact: true }).click()
    }
    await expect(editor).toHaveText("Linked draft")
    await editor.press("Enter")
    await expect.poll(() => created).toEqual([target])
    await expect(page).toHaveURL(new RegExp(`/${base64Encode(target)}/session/${session.id}$`))
    await page.goto(homeEntry)
    await expect(composer.getByRole("textbox")).toHaveText("Root draft")
  })
}
