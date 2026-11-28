import { describe, expect, test } from "bun:test"
import { provider, wantsFlashAnchor, wantsStepAnchor } from "../../src/session/system"
import PROMPT_GLM from "../../src/session/prompt/glm.md" with { type: "text" }
import PROMPT_DEEPSEEK from "../../src/session/prompt/deepseek.md" with { type: "text" }
import PROMPT_GPT from "../../src/session/prompt/gpt.md" with { type: "text" }
import PROMPT_STEP from "../../src/session/prompt/step.md" with { type: "text" }
import PROMPT_HY from "../../src/session/prompt/hy.md" with { type: "text" }
import PROMPT_QWEN from "../../src/session/prompt/qwen.md" with { type: "text" }
import PROMPT_DEFAULT from "../../src/session/prompt/default.md" with { type: "text" }
import PROMPT_WORKING_STYLE from "../../src/session/prompt/working-style.md" with { type: "text" }

// 260827 cc 这一组钉的是同一类 bug：**模型换个名字接入，就被静默换掉一套待遇**。
// GLM-5.3-Flash 先前以 ox-alpha / x-preview 名义在跑（走 default.md、不吃推理锚），
// 换成智谱官方名字后 api.id 里出现 "glm"、model.id 里出现 "flash"，于是提示词和锚
// 两处同时被换掉，而两处都没有针对它的证据。
const model = (apiID: string, providerID = "zhipuai-coding-plan") =>
  ({ api: { id: apiID }, providerID, id: apiID }) as unknown as Parameters<typeof provider>[0]

describe("system prompt routing", () => {
  test("GLM 系走 default.md + glm.md", () => {
    for (const id of ["glm-5.3-flash", "glm-5.3", "glm-5.2", "GLM-5.3-Flash"])
      expect(provider(model(id))).toEqual([PROMPT_DEFAULT, PROMPT_GLM])
  })

  test("GPT 系走 default.md + gpt.md", () => {
    expect(provider(model("gpt-5.6-luna", "openai"))).toEqual([PROMPT_DEFAULT, PROMPT_GPT, PROMPT_WORKING_STYLE])
  })

  test("已删除专属提示词的 Claude 系走默认提示词", () => {
    expect(provider(model("claude-sonnet-4-5", "anthropic"))).toEqual([PROMPT_DEFAULT])
  })

  // 260829 cc hy 的判据是 `hy` + 数字并带边界。写成 includes("hy") 会命中任何名字里
  // 带 hy 的模型，这一组就是钉住那条边界。
  // 261117 Red hy.md 并入公共基线（同 260921 决策），断言随之加上 default.md 前缀。
  test("Hy 系走 default.md + hy.md，两家 provider 的 id 形态都要命中", () => {
    for (const id of ["hy4-preview", "hy4Flash", "hy3", "tencent/hy4-preview", "Hy4-Preview"])
      expect(provider(model(id, "opencode-go"))).toEqual([PROMPT_DEFAULT, PROMPT_HY])
  })

  test("名字里带 hy 但不是混元的，不许被 hy.md 捞走", () => {
    // 没有数字紧跟、或 hy 不在边界上的，一律落兜底
    for (const id of ["hyper-model", "why3-turbo", "physics-2"])
      expect(provider(model(id, "opencode-go"))).toEqual([PROMPT_DEFAULT])
  })

  // 261013 Red minimax.md / ollama.md 已删（不再用这两家）。删一条分支属于同一类改动——
  // 「模型换个名字接入就被静默换掉一套待遇」的反向版本，所以这里把新落点钉住：
  // minimax 与 ollama 上的非 qwen 模型落兜底，本地 qwen 仍走 qwen.md（该分支被保留）。
  test("已删专属档的 minimax / ollama 落兜底，本地 qwen 不受影响", () => {
    expect(provider(model("minimax-m2.5", "minimax"))).toEqual([PROMPT_DEFAULT])
    expect(provider(model("llama3.2", "ollama"))).toEqual([PROMPT_DEFAULT])
    expect(provider(model("qwen3.8", "ollama"))).toEqual([PROMPT_QWEN])
  })

  test("deepseek / Step 路由使用公共基线与专属 Delta", () => {
    expect(provider(model("deepseek-v4-flash-vision-exp", "deepseek"))).toEqual([PROMPT_DEFAULT, PROMPT_DEEPSEEK])
    for (const id of ["step-3.7-flash", "step-5-preview"])
      expect(provider(model(id, "stepfun-step-plan"))).toEqual([PROMPT_DEFAULT, PROMPT_STEP, PROMPT_WORKING_STYLE])
  })
})

describe("推理锚归属", () => {
  test("flash 锚只给 deepseek 系——它的证据来源就只有 deepseek", () => {
    expect(wantsFlashAnchor("deepseek-v4-flash")).toBe(true)
    expect(wantsFlashAnchor("deepseek-v4-flash-vision-exp")).toBe(true)
  })

  test("名字里带 flash 但不是 deepseek 的，一律不吃 flash 锚", () => {
    for (const id of ["glm-5.3-flash", "gemini-3.7-flash", "step-3.7-flash", "x-preview-f-free"])
      expect(wantsFlashAnchor(id)).toBe(false)
  })

  test("step 锚按 provider 或名字命中，且与 flash 锚互斥", () => {
    expect(wantsStepAnchor("step-3.7-flash", "stepfun-step-plan")).toBe(true)
    expect(wantsStepAnchor("some-model", "stepfun")).toBe(true)
    expect(wantsStepAnchor("deepseek-v4-flash", "deepseek")).toBe(false)
    expect(wantsStepAnchor("glm-5.3-flash", "zhipuai-coding-plan")).toBe(false)
  })
})

// 261001 Red Shared state transitions must not remain GPT-only after the contract migration.
describe("shared agent contract", () => {
  // 261025 Red 调优只绑定有失效证据的家族，不把 GPT/Step 的约束扩散给其它模型。
  test("GPT and Step receive their delivery and interaction tuning once", () => {
    for (const id of ["gpt-6.1-sol", "step-5-preview"]) {
      const prompts = provider(model(id))
      expect(prompts.at(-1)).toBe(PROMPT_WORKING_STYLE)
      expect(prompts.filter((prompt) => prompt === PROMPT_WORKING_STYLE)).toHaveLength(1)
    }
  })

  test("other model families do not inherit GPT and Step delivery tuning", () => {
    for (const id of [
      "glm-5.3",
      "deepseek-v4",
      "mimo-v2.6",
      "claude-sonnet-4-5",
      "gemini-3.7-pro",
      "trinity",
      "kimi",
      "hy4-preview",
      "grok",
      "unknown-model",
    ]) {
      expect(provider(model(id))).not.toContain(PROMPT_WORKING_STYLE)
    }
    for (const [id, providerID] of [
      ["qwen3.8", "ollama"],
      ["u1-fast", "sensenova"],
    ]) {
      expect(provider(model(id, providerID))).not.toContain(PROMPT_WORKING_STYLE)
    }
  })

})
