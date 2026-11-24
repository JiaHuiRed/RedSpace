import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture } from "./session-timeline.fixture"

const port = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"

test("Chat renames, archives and restores conversations, and switches partner from an open conversation", async ({
  page,
}) => {
  const profiles = ["Luna", "Mei"].map((name) => ({
    id: name,
    name,
    directory: fixture.directory,
    soulID: name,
    createdAt: 1,
    files: 0,
    timezone: "UTC",
    warnings: [],
  }))
  const chat = {
    ...fixture.sessions[0]!,
    id: "ses_history_luna",
    title: "Initial name",
    mode: "chat",
    companionID: "Luna",
    soul: "Luna",
    time: { created: 1, updated: 2, archived: undefined as number | undefined },
  }
  const other = { ...chat, id: "ses_history_mei", title: "Other conversation", companionID: "Mei", soul: "Mei" }
  const sessions = [chat, other]
  let failRename = true
  await mockRedCodeServer(page, { ...fixture, sessions, pageMessages: () => ({ items: [] }) })
  await page.route(
    (url) => url.port === port,
    async (route) => {
      const request = route.request()
      const { pathname, searchParams } = new URL(request.url())
      if (request.method() === "OPTIONS") return route.fallback()
      if (pathname === "/companion") return route.fulfill({ json: profiles })
      const detail = profiles.find((p) => pathname === "/companion/" + p.id)
      if (detail)
        return route.fulfill({
          json: { profile: detail, paths: { directory: detail.directory, memory: detail.directory + "/MEMORY.md" } },
        })
      const soul = profiles.find((p) => pathname === "/soul/" + p.soulID)
      if (soul) return route.fulfill({ json: { id: soul.soulID, name: soul.name } })
      if (pathname === "/experimental/session") {
        return route.fulfill({
          json: sessions.filter(
            (s) =>
              s.companionID === searchParams.get("companionID") &&
              (s.time.archived !== undefined) === (searchParams.get("archivedOnly") === "true"),
          ),
        })
      }
      if (pathname === "/session/" + chat.id && request.method() === "PATCH") {
        const patch = request.postDataJSON()
        if (patch.title && failRename) return route.fulfill({ status: 503, json: { message: "Write failed" } })
        if (patch.title) chat.title = patch.title
        if (patch.time) chat.time.archived = patch.time.archived
        if (patch.unarchive) chat.time.archived = undefined
        return route.fulfill({ json: chat })
      }
      return route.fallback()
    },
  )
  await page.goto("/chat?companion=Luna")
  const rail = page.locator(".companion-rail")
  const nav = rail.getByRole("navigation")
  const more = page.getByRole("button", { name: "Conversation options" })
  await more.click()
  await expect(page.locator(".companion-options").getByRole("button", { name: /settings/i })).toHaveCount(0)
  await more.click()
  await page.locator(".companion-settings").click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  const initial = nav.getByRole("link", { name: "Initial name" })
  await initial.click()
  await expect(initial).toHaveAttribute("aria-current", "page")
  const action = (name: string) => nav.getByRole("button", { name: "More options · " + name })
  await action("Initial name").click()
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const dialog = page.getByRole("dialog", { name: "Rename" })
  await dialog.getByRole("textbox").fill("Deployment notes")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Write failed").first()).toBeVisible()
  await expect(dialog.getByRole("textbox")).toHaveValue("Deployment notes")
  failRename = false
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(page.locator(".companion-page-title")).toHaveText("Deployment notes")
  await action("Deployment notes").click()
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click()
  await expect(page).toHaveURL(/\/chat\?companion=Luna$/)
  await expect(nav.getByRole("link", { name: "Deployment notes" })).toHaveCount(0)
  const archived = rail.getByRole("button", { name: "Show archived sessions" })
  await archived.click()
  await action("Deployment notes").click()
  await page.getByRole("menuitem", { name: "Unarchive" }).click()
  await expect(nav.getByRole("link", { name: "Deployment notes" })).toHaveCount(0)
  await archived.click()
  const restored = nav.getByRole("link", { name: "Deployment notes" })
  await restored.click()
  await expect(restored).toHaveAttribute("aria-current", "page")
  await more.click()
  await page.locator(".companion-options select").selectOption("Mei")
  await expect(nav.getByRole("link", { name: "Other conversation" })).toBeVisible()
  await expect(nav.getByRole("link", { name: "Deployment notes" })).toHaveCount(0)
})

test("Chat history finds a conversation beyond the first page, including by message", async ({ page }) => {
  const profile = { id: "Luna", name: "Luna", directory: fixture.directory, soulID: "Luna" }
  const first = { ...fixture.sessions[0]!, title: "Recent conversation", mode: "chat", companionID: profile.id }
  const older = { ...first, id: "ses_old", title: "Spring notebook" }
  const cursor = "1700000000000:ses_last"
  const requests: string[] = []
  await mockRedCodeServer(page, { ...fixture, sessions: [first, older], pageMessages: () => ({ items: [] }) })
  await page.route(
    (url) => url.port === port,
    (route) => {
      const { pathname, searchParams } = new URL(route.request().url())
      if (pathname === "/companion") return route.fulfill({ json: [profile] })
      if (pathname === "/experimental/session") {
        const after = searchParams.get("cursor")
        requests.push(after ?? "")
        return after === cursor
          ? route.fulfill({ json: [older] })
          : route.fulfill({
              json: [first],
              headers: { "x-next-cursor": cursor, "access-control-expose-headers": "x-next-cursor" },
            })
      }
      if (pathname.endsWith("/query"))
        return route.fulfill({
          json: { results: pathname.includes("/ses_old/") ? [{ messageID: "msg_match" }] : [] },
        })
      return route.fallback()
    },
  )
  await page.goto("/chat?companion=Luna")
  const rail = page.locator(".companion-rail")
  await expect(rail.getByRole("link", { name: "Recent conversation" })).toBeVisible()
  await expect(rail.getByText("Spring notebook")).toHaveCount(0)
  await rail.getByRole("button", { name: "Search chats" }).click()
  await rail.getByRole("searchbox").fill("cherry blossoms")
  await rail.getByRole("searchbox").press("Enter")
  await expect(rail.getByRole("link", { name: "Spring notebook" })).toBeVisible()
  expect(requests).toContain(cursor)
  await page.keyboard.press("Escape")
  await rail.getByRole("button", { name: "Load more" }).click()
  await rail.getByRole("link", { name: "Spring notebook" }).click()
  await expect(page).toHaveURL(new RegExp(base64Encode(fixture.directory) + "/session/ses_old$"))
})
