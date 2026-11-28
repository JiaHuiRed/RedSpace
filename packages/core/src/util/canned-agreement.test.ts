import { expect, test } from "bun:test"
import { createCannedAgreementFilter, filterCannedAgreement } from "./canned-agreement"

/**
 * 261121 Red 方案三验收①：任意输入的每个增量前缀，增量过滤输出必须与全文版逐字相等。
 * 覆盖方案三验收清单——「如果你说得对」条件从句、跨更新的「我认」→「我认得」、跨行引号、
 * 代码围栏、列表、流中替换、片段切换——以及行首判定机的全部解算分支。
 */
function expectPrefixEquality(text: string, chunk = 1) {
  const filter = createCannedAgreementFilter()
  for (let end = chunk; end < text.length; end += chunk) {
    const frame = text.slice(0, end)
    expect(filter.update("k", frame)).toBe(filterCannedAgreement(frame))
  }
  expect(filter.update("k", text)).toBe(filterCannedAgreement(text))
}

test("single-frame results equal the full-text filter", () => {
  const samples = [
    "",
    "说得对",
    "你说得对，我们再看数据。",
    "如果你说得对，我们再看数据。",
    "我认",
    "我认得",
    "我认，这是事实。",
    "我认 x",
    "哥哥，",
    "哥哥，你说得对。",
    "12. 你说得对",
    "1.2 万个理由",
    "1) 你说得对",
    "12)34 x",
    "#######",
    "## 标题",
    "- 你说得对",
    "-   x",
    "    你说得对",
    "\t你说得对",
    "> 你说得对",
    "`` x 你说得对",
    "```js\n你说得对\n```\n afterwards",
    "```\n说 nothing\n",
    "说点别的 ``code`` 你说得对",
    "“跨行引号\n你说得对\n”之后",
    "前言\n“引用开始\n你说得对\n”结束",
    "0.5 的概率你说得对",
    "　全角空格你说得对",
    // 261121 Red：多字符行首 run 的后续字符必须继续留在前导候选里，否则增量版
    // 会把整个标题/编号前导并进套话分句一起删掉（0.20.2 显示回归）。
    "## 你说得对。继续排查",
    "12. 你说得对。继续排查",
    "### 12. 你说得对。继续排查",
    "## 12.5 你说得对。继续排查",
    "####### 你说得对。继续排查",
  ]
  for (const text of samples) expectPrefixEquality(text)
})

test("per-prefix equality across chunk sizes for prose, lists and literal blocks", () => {
  const prose = "说起上次写的文档，里面还有几段值得保留。".repeat(6)
  expectPrefixEquality(prose, 1)
  expectPrefixEquality(prose, 5)
  expectPrefixEquality(prose.replace(/。/g, " "), 3) // 无边界长单行
  expectPrefixEquality("1. 主题：你说得对\n2. 我认得这个道理\n- 别你说得对", 2)
  expectPrefixEquality("```js\nconst a = 1; // 你说得对\n```\n好的，我认得。", 4)
  expectPrefixEquality("“第一行引号\n你说得对\n”第二行", 3)
  expectPrefixEquality("    indented 你说得对\n\t我认得\n> quoted 你说得对", 2)
})

test("untriggered text passes through until a trigger appears, then rescans", () => {
  const filter = createCannedAgreementFilter()
  const plain = "一段完全无关的中文。"
  expect(filter.update("k", plain)).toBe(plain)
  expect(filter.update("k", plain + "你说得对。")).toBe(filterCannedAgreement(plain + "你说得对。"))
})

// 261121 Red 随机模糊：固定种子的结构化字母表，逐前缀与全文版逐字相等。
test("seeded fuzz: incremental output equals full-text at every prefix", () => {
  // 种子伪随机（xorshift），避免依赖 Math.random 导致失败不可复现
  let seed = 0x9e3779b9
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x100000000
  }
  const alphabet = [
    "说",
    "我认",
    "你说得对",
    "我认得",
    "如果",
    "哥哥",
    "哥",
    "，",
    "。",
    "！",
    "、",
    " ",
    "  ",
    "\t",
    "\n",
    "1",
    "12",
    ".",
    ")",
    "#",
    "##",
    "#######",
    "-",
    "*",
    "+",
    ">",
    "`",
    "``",
    "```",
    "~",
    "~~~",
    "“",
    "”",
    "「",
    '"',
    "x",
    "中",
  ]
  for (let round = 0; round < 300; round++) {
    let text = ""
    const parts = 1 + Math.floor(next() * 24)
    for (let i = 0; i < parts; i++) text += alphabet[Math.floor(next() * alphabet.length)]!
    try {
      expectPrefixEquality(text, next() < 0.5 ? 1 : 3)
    } catch (error) {
      console.log("FUZZ INPUT:", JSON.stringify(text))
      throw error
    }
  }
})
