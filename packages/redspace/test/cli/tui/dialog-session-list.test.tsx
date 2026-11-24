/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { DialogSessionList } from "../../../src/cli/cmd/tui/component/dialog-session-list"
import { context as LocalContext } from "../../../src/cli/cmd/tui/context/local"
import { projectContext } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider } from "../../../src/cli/cmd/tui/context/route"
import { mountBackgroundDialog } from "../../fixture/background-dialog"

test("an open Code session picker accepts late sync without moving existing choices", async () => {
  const row = (title: string, updated: number) => ({ id: title, title, time: { created: 1, updated } })
  const [data, setData] = createStore({ session: [] as ReturnType<typeof row>[], session_status: {} })
  const local = { session: { pinned: () => [], slots: () => [] } }
  const modal = await mountBackgroundDialog(
    () => (
      <RouteProvider>
        <projectContext.Provider value={{} as never}>
          <LocalContext.Provider value={local as never}>
            <DialogSessionList />
          </LocalContext.Provider>
        </projectContext.Provider>
      </RouteProvider>
    ),
    {},
    { data, session: { query: () => ({}) } },
  )
  try {
    expect(await modal.paint()).toContain("Code")
    setData("session", [row("Older task", 1), row("Recent task", 2)])
    const first = await modal.paint()
    expect(first).toContain("Recent task")
    expect(first.indexOf("Recent task")).toBeLessThan(first.indexOf("Older task"))
    setData("session", [row("Older task", 4), row("Recent task", 2), row("Incoming task", 5)])
    const next = await modal.paint()
    expect(next).toContain("Incoming task")
    expect(next.indexOf("Recent task")).toBeLessThan(next.indexOf("Older task"))
    setData("session", (items) => items.filter((item) => item.title !== "Recent task"))
    expect(await modal.paint()).not.toContain("Recent task")
  } finally {
    modal.app.renderer.destroy()
  }
})
