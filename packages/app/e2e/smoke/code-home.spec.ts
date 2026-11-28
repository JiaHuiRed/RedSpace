import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture } from "./session-timeline.fixture"

const homeEntry = `/${base64Encode(fixture.directory)}/session`
const newSession = { ...fixture.sessions[0]!, id: "ses_home_first", title: "First from the workspace" }

test("Code workspace puts the composer below usage and caps only unfiltered idle cards", async ({ page }) => {
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
  await page.locator('[data-action="home-new-session-sidebar"]').click()
  await expect(editor).toBeFocused()
  // 261124 YuQi 布局重排：usage 位于输入区上方，不再属于 board-section。
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

test("a browser project menu only offers actions available in the browser", async ({ page }) => {
  await page.addInitScript((directory) => {
    localStorage.setItem("RedCode.global.dat:server", JSON.stringify({
      projects: { local: [{ worktree: directory, expanded: true }] },
    }))
  }, fixture.directory)
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.goto("/")
  await page.locator('[data-action="home-project-row"]').first().click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible()
  await expect(page.locator('[data-action="home-project-reveal"]')).toHaveCount(0)
})

test("the composer keeps a usable column when Code shares a narrow window", async ({ page }) => {
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(homeEntry)
  const host = page.locator('[data-component="home-compose-section"]')
  const editor = host.locator('[data-component="prompt-input"]')
  await expect(editor).toBeAttached()
  for (const width of [390, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 })
    const available = await host.evaluate((el) => Math.round(el.getBoundingClientRect().width))
    expect(available, "composer column in a " + width + "px window").toBeGreaterThanOrEqual(280)
    await editor.fill("Draft in a " + width + "px window")
    await expect(editor).toHaveText("Draft in a " + width + "px window")
  }
})

test("Code archive retries an outage and reaches older tasks by search or pagination", async ({ page }) => {
  const archived = {
    ...fixture.sessions[0]!,
    title: "Old deployment notes",
    time: { created: 1, updated: 1, archived: 2 },
  }
  const active = Array.from({ length: 65 }, (_, i) => ({
    ...fixture.sessions[0]!,
    id: "ses_active_" + i,
    title: "Active task " + i,
    time: { created: i + 3, updated: i + 3 },
  }))
  const recent = Array.from({ length: 64 }, (_, i) => ({
    ...archived,
    id: "ses_archive_" + i,
    title: "Recent archive " + i,
    time: { created: 65 - i, updated: 65 - i, archived: 66 },
  }))
  const cursor = "2:ses_archive_63"
  let offline = true
  await page.addInitScript(
    (directory) =>
      localStorage.setItem(
        "RedCode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
        }),
      ),
    fixture.directory,
  )
  await mockRedCodeServer(page, { ...fixture, sessions: active, pageMessages: () => ({ items: [] }) })
  await page.route(
    (url) => url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && url.pathname === "/experimental/session",
    (route) => {
      if (offline) return route.fulfill({ status: 503, json: { message: "Offline" } })
      const query = new URL(route.request().url()).searchParams
      if (query.get("archivedOnly") !== "true") {
        return route.fulfill({ json: active.slice(0, Number(query.get("limit"))) })
      }
      if (query.get("search") === archived.title || query.get("cursor") === cursor) {
        return route.fulfill({ json: [archived] })
      }
      return route.fulfill({
        json: recent,
        headers: { "x-next-cursor": cursor, "access-control-expose-headers": "x-next-cursor" },
      })
    },
  )
  await page.goto("/")
  await page.locator('[data-action="home-toggle-archived"]').click()
  const board = page.locator('[data-component="home-board-section"]')
  const retry = board.getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible({ timeout: 20_000 })
  await expect(board.getByText("No archived sessions")).toHaveCount(0)
  offline = false
  await retry.click()
  await expect(board.getByText(recent[0]!.title)).toBeVisible()
  await expect(board.getByText(archived.title)).toHaveCount(0)

  const search = page.locator('[data-component="home-session-search"] input')
  await search.fill(archived.title)
  await expect(board.getByText(archived.title)).toBeVisible()
  await search.clear()
  await expect(board.getByText(archived.title)).toHaveCount(0)
  await board.getByRole("button", { name: "Load more" }).click()
  await expect(board.getByText(recent[0]!.title)).toBeVisible()
  await expect(board.getByText("Old deployment notes")).toBeVisible()
})

test("workspaces can be searched and collapsed without leaving Code", async ({ page }) => {
  const worktree = "C:/RedCode/ExtraWorkspace"
  await page.addInitScript(({ root, worktree }) => {
    localStorage.setItem("RedCode.global.dat:server", JSON.stringify({
      projects: { local: [{ worktree: root, expanded: true }, { worktree, expanded: true }] },
    }))
    localStorage.setItem("redcode-home-projects-expanded", "0")
  }, { root: fixture.directory, worktree })
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.goto("/")
  const toggle = page.locator('[data-action="home-projects-toggle"]')
  const filter = page.locator('[data-action="home-projects-search"]')
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(filter).toBeVisible()
  await filter.fill("extrawork")
  const result = page.locator("#home-all-workspaces [data-action=home-project-row]")
  await expect(result).toHaveCount(1)
  await expect(result).toContainText("ExtraWorkspace")
  await result.click()
  await expect(result).toHaveAttribute("aria-current", "page")
  await expect(page).toHaveURL(/\/$/)
  await filter.press("Escape")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(toggle).toBeFocused()
})

test("Skill Deck reuses slash selection, keeps the draft and supports favorites", async ({ page }) => {
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route("**/command?**", (route) => route.fulfill({ json: [
    { name: "review-ui", description: "Review a screenshot", source: "skill" },
    { name: "reopen", description: "A regular command", source: "command" },
  ] }))
  await page.goto(homeEntry)
  const editor = page.locator('[data-component="home-compose-section"] [data-component="prompt-input"]')
  const trigger = page.locator('[data-action="prompt-skills"]')
  const search = page.locator('[data-action="prompt-skills-search"]')
  await editor.fill("Existing draft")
  await trigger.click()
  await search.fill("review")
  const insert = page.getByRole("button", { name: "Insert", exact: true })
  await expect(insert).toBeDisabled()
  await expect(editor).toHaveText("Existing draft")
  await search.press("Escape")
  await expect(trigger).toBeFocused()
  await editor.fill("")
  await trigger.click()
  await expect(page.getByText("reopen", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Favorites: review-ui" }).click()
  await page.getByRole("button", { name: "Favorites", exact: true }).click()
  await expect(insert).toBeEnabled()
  await insert.click()
  await expect(editor).toContainText("/review-ui")
  await expect(search).toBeHidden()
  await expect(page.getByText("Loaded in this session", { exact: false })).toHaveCount(0)
  // The Enter emitted mid-composition must not submit the command.
  await editor.dispatchEvent("compositionstart")
  await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true })
  await expect(editor).toContainText("/review-ui")
})

test("recent image tiles use completed workspace outputs and open the shared preview", async ({ page }) => {
  const session = fixture.sessions[0]!
  const imagePath = ".redcode/temp/smoke.png"
  const [user, assistant] = fixture.messages[fixture.sourceID].slice(-2)
  const tool = {
    id: "prt_smoke_image",
    type: "tool",
    tool: "image",
    sessionID: session.id,
    messageID: assistant!.info.id,
    callID: "call_smoke_image",
    state: {
      status: "completed",
      input: {},
      title: "smoke.png",
      output: "Generated image",
      metadata: { filepath: `${fixture.directory}/${imagePath}`, bytes: 68 },
      time: { start: 1700000000000, end: 1700000001000 },
    },
  }
  await page.addInitScript((directory) => {
    localStorage.setItem("RedCode.global.dat:server", JSON.stringify({
      projects: { local: [{ worktree: directory, expanded: true }] },
    }))
  }, fixture.directory)
  await mockRedCodeServer(page, {
    ...fixture,
    sessions: [session],
    pageMessages: () => ({ items: [user!, { ...assistant!, parts: [tool] }] }),
  })
  const reads: string[] = []
  await page.route("**/file/content?**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path")
    if (path !== imagePath) return route.fallback()
    reads.push(path)
    return route.fulfill({ json: {
      type: "binary", encoding: "base64", mimeType: "image/png",
      content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    } })
  })
  await page.goto(`${homeEntry}/${session.id}`)
  await expect(page.getByRole("button", { name: "View preview " + imagePath })).toBeVisible()
  await page.locator('[data-mode=code]').click()
  const tile = page.getByRole("button", { name: "smoke.png", exact: true })
  await expect(tile).toBeVisible()
  await expect(tile.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/)
  await tile.press("Enter")
  await expect(page.locator('[data-slot="image-preview-image"]')).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(tile).toBeFocused()
  expect(reads).toEqual([imagePath])
})
