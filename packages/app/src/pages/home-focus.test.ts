import { describe, expect, test } from "bun:test"
import { focusProjectRow } from "./home-focus"

function mount(projects: string[]) {
  const root = document.createElement("div")
  for (const directory of projects) {
    const button = document.createElement("button")
    button.dataset.component = "home-project-row"
    button.dataset.project = directory
    root.append(button)
  }
  document.body.append(root)
  return {
    root,
    dispose: () => {
      root.remove()
    },
  }
}

describe("home project focus", () => {
  test("moves focus to the same project's row after grouping moves it", () => {
    const { root, dispose } = mount(["A", "B"])
    try {
      expect(focusProjectRow("B", root)).toBe(true)
      expect(document.activeElement?.getAttribute("data-project")).toBe("B")
    } finally {
      dispose()
    }
  })

  test("does not steal focus when the user already moved elsewhere", () => {
    const { root, dispose } = mount(["A"])
    try {
      const input = document.createElement("input")
      root.append(input)
      input.focus()
      expect(focusProjectRow("A", root)).toBe(false)
      expect(document.activeElement).toBe(input)
    } finally {
      dispose()
    }
  })

  test("reports false when the project no longer has a row", () => {
    const { root, dispose } = mount(["A"])
    try {
      expect(focusProjectRow("missing", root)).toBe(false)
    } finally {
      dispose()
    }
  })
})
