import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture } from "./session-timeline.fixture"

const homeEntry = `/${base64Encode(fixture.directory)}/session`
const newSession = { ...fixture.sessions[0]!, id: "ses_home_first", title: "First from the workspace" }

test("Code workspace puts the composer above usage and caps only unfiltered idle cards", async ({ page }) => {
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
  await expect(board.locator('[data-frost-surface="home-usage"]')).toBeVisible()
  expect(await composer.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
    await board.evaluate((el) => el.getBoundingClientRect().top),
  )
  const cards = board.locator('[data-component="kanban-card"]')
  await expect(cards).toHaveCount(9)
  await expect(cards.first()).toContainText("Code task 11")
  const search = board.getByRole("textbox")
  await search.fill("Code task 00")
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText("Code task 00")
  await search.clear()
  await board.locator('[data-action="home-new-session"]').click()
  await expect(editor).toBeFocused()
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
