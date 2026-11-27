import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { fixture } from "./session-timeline.fixture"
import { mockRedCodeServer } from "../utils/mock-server"

// 1x1 PNG; the UI must show the original returned by the file service, not an inline
// attachment or a data URL carried in tool metadata.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const imagePath = ".redcode/temp/image-gen.png"

test("completed image generation becomes a deliverable that opens the original on demand", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const sessionID = "ses_image_deliverable"
  const userID = "msg_image_user"
  const assistantID = "msg_image_assistant"
  const now = Date.now()
  const absolute = `${fixture.directory}/${imagePath}`
  const tool = (id: string, state: Record<string, unknown>) => ({
    id,
    sessionID,
    messageID: assistantID,
    type: "tool",
    tool: "image",
    callID: `call_${id}`,
    state: {
      input: { prompt: "draw a lantern" },
      time: { start: now + 2, end: now + 3 },
      ...state,
    },
  })
  const messages = [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "redcode", modelID: "claude-opus-4-6" },
      },
      parts: [
        {
          id: "prt_image_user",
          sessionID,
          messageID: userID,
          type: "text",
          text: "Draw a lantern and show me the result.",
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: now + 1, completed: now + 20 },
        providerID: "redcode",
        modelID: "claude-opus-4-6",
        agent: "build",
        mode: "build",
        finish: "stop",
        cost: 0,
        path: { cwd: fixture.directory, root: fixture.directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        tool("prt_image_done", {
          status: "completed",
          metadata: {
            filepath: absolute,
            mode: "generate",
            provider: "openai",
            model: "gpt-image-1",
            bytes: 68,
            mime: "image/png",
          },
          output: `Generated image: ${absolute}`,
          title: "image-gen.png",
        }),
        tool("prt_image_failed", {
          status: "error",
          error: "Image provider failed",
          metadata: { filepath: `${fixture.directory}/.redcode/temp/image-failed.png`, mode: "generate" },
        }),
        tool("prt_image_external", {
          status: "completed",
          metadata: { filepath: "C:/Elsewhere/image.png", mode: "generate" },
          output: "Generated image: C:/Elsewhere/image.png",
        }),
        { id: "prt_image_text", sessionID, messageID: assistantID, type: "text", text: "The lantern is ready." },
      ],
    },
  ]
  await mockRedCodeServer(page, {
    ...fixture,
    sessions: [{ ...fixture.sessions[0]!, id: sessionID, title: "Image deliverable smoke" }],
    pageMessages: () => ({ items: messages }),
  })
  await page.route(`**/session/${sessionID}/outline?**`, (route) =>
    route.fulfill({ json: { entries: [] }, headers: { "access-control-allow-origin": "*" } }),
  )
  await page.route(`**/session/${sessionID}/query?**`, (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { results: [], scannedParts: 4 },
    }),
  )
  const requested: string[] = []
  await page.route("**/file/content?**", (route) => {
    const url = new URL(route.request().url())
    requested.push(url.searchParams.get("path") ?? "")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ type: "text", content: png, mimeType: "image/png", encoding: "base64" }),
    })
  })
  await page.goto(`/${base64Encode(fixture.directory)}/session/${sessionID}`)
  const panel = page.locator('[data-component="turn-deliverables"]')
  await expect(panel).toBeVisible()
  // Failed and external images are not deliverables; only the completed workspace image is.
  await expect(panel.locator("article")).toHaveCount(1)
  await expect(panel.getByText("image-gen.png", { exact: true })).toBeVisible()
  await expect(page.locator('[data-timeline-part-id="prt_image_failed"]')).toContainText("Failed")
  // The card itself must not preload the original.
  expect(requested).toEqual([])
  // The tool card keeps metadata as the path and opens the same preview; it must not
  // render a second inline copy of the image.
  const toolPart = page.locator('[data-timeline-part-id="prt_image_done"]')
  await expect(toolPart.locator("img")).toHaveCount(0)
  await toolPart.locator('[data-slot="basic-tool-tool-subtitle"]').click()
  const image = page.locator(`#review-panel img[alt="${imagePath}"]`)
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/)
  expect(requested).toEqual([imagePath])
  await panel.getByRole("button", { name: `View preview ${imagePath}` }).click()
  await expect(page.getByRole("tab", { name: "image-gen.png" })).toHaveAttribute("aria-selected", "true")
  await expect(image).toBeVisible()
  expect(errors).toEqual([])
})
