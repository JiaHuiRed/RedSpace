import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { HomeFlightRecorderEntry } from "./home-flight-recorder-entry"

// 261126 Red FR-04 首页入口：没有选中项目时不能留一个点了没反应的按钮。
test("home flight recorder entry is disabled with a visible reason without a selected project", () => {
  const container = document.createElement("div")
  document.body.append(container)
  let opened = 0
  const dispose = render(
    () => (
      <HomeFlightRecorderEntry
        label="Project execution history"
        disabledReason="Select a project first to open its execution history."
        disabled
        onOpen={() => opened++}
      />
    ),
    container,
  )
  try {
    const button = container.querySelector<HTMLButtonElement>('[data-testid="home-flight-recorder-open"]')!
    expect(button.disabled).toBe(true)
    button.click()
    expect(opened).toBe(0)
    expect(container.querySelector('[data-testid="home-flight-recorder-disabled"]')?.textContent).toContain(
      "Select a project first",
    )
  } finally {
    dispose()
    container.remove()
  }
})

test("home flight recorder entry opens when a project is selected", () => {
  const container = document.createElement("div")
  document.body.append(container)
  let opened = 0
  const dispose = render(
    () => (
      <HomeFlightRecorderEntry
        label="Project execution history"
        disabledReason="Select a project first to open its execution history."
        disabled={false}
        onOpen={() => opened++}
      />
    ),
    container,
  )
  try {
    const button = container.querySelector<HTMLButtonElement>('[data-testid="home-flight-recorder-open"]')!
    expect(button.disabled).toBe(false)
    expect(container.querySelector('[data-testid="home-flight-recorder-disabled"]')).toBeNull()
    button.click()
    expect(opened).toBe(1)
  } finally {
    dispose()
    container.remove()
  }
})
