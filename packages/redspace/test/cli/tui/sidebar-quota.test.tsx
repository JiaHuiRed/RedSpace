/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { ProviderQuota } from "@redcode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { context as LocalContext } from "../../../src/cli/cmd/tui/context/local"
import { QuotaView } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/quota"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

const quota = (providerID: string, planType: string): ProviderQuota => ({ providerID, capturedAt: 1, planType })

test("quota sidebar follows the live model selection", async () => {
  const [providerID, setProviderID] = createSignal("openai")
  const api = createTuiPluginApi({
    client: { provider: { quota: async () => ({ data: [] }) } } as unknown as TuiPluginApi["client"],
    state: { provider_quota: () => [quota("zhipuai-coding-plan", "GLM"), quota("zhipuai-coding-plan", "Max"), quota("openai", "plus")] },
  })
  const app = await testRender(
    () => (
      <LocalContext.Provider
        value={{ model: { current: () => ({ providerID: providerID(), modelID: "test-model" }) } } as never}
      >
        <QuotaView api={api} session_id="s1" />
      </LocalContext.Provider>
    ),
    { width: 60, height: 20 },
  )
  try {
    await app.renderOnce()
    const first = app.captureCharFrame()
    expect(first.indexOf("plus")).toBeLessThan(first.indexOf("GLM"))
    expect(first.split("\n").find((line) => line.includes("plus"))).toContain("当前")

    setProviderID("zhipuai-coding-plan")
    await app.renderOnce()
    const next = app.captureCharFrame()
    expect(next.indexOf("GLM")).toBeLessThan(next.indexOf("plus"))
    expect(next).toContain("当前供应商 · zhipuai-coding-plan")
    expect(next.split("\n").find((line) => line.includes("GLM"))).not.toContain("当前")
  } finally {
    app.renderer.destroy()
  }
})
