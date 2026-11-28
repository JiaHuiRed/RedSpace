// Opt-in replay of the Pi checkout investigation. The operator supplies two trusted source archives;
// the model can select one of two fixed commands but cannot supply a path, program, or argument.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cases, type EvalCase } from "./prompt-eval-cases"
import { checkPiCheckout } from "./prompt-eval-delivery"

const clean = process.env.PI_EVAL_CLEAN_TUI
const prepared = process.env.PI_EVAL_READY_TUI
const hint = process.env.PI_EVAL_RECOVERY_HINT
const node = Bun.which("node")
if (!clean || !prepared || !node || (hint !== "0" && hint !== "1"))
  throw new Error("Set PI_EVAL_CLEAN_TUI, PI_EVAL_READY_TUI and PI_EVAL_RECOVERY_HINT=0 or 1; Node is required.")
const script = "test/alt-screen-large-transcript-bench.ts"
for (const dir of [clean, prepared]) {
  const hash = createHash("sha256").update(readFileSync(join(dir, script))).digest("hex")
  if (hash !== "9d83d1544d067a3a92ae139b009d1544761b14e4225d4377fcd2e2e7758e738f")
    throw new Error("Unexpected benchmark bytes; use git archive at Pi 2126569de.")
}
const scenario = {
  id: "pi-checkout",
  input: "这个 Pi 终端在长对话里是不是一直都快？先试当前 checkout，别修改它；我要本机四种交互的实测 ms/frame。把结果按 steady、scroll、streaming、resize 四个数和 slowest 名称写成一个 JSON 对象。",
  files: {
    "BENCHMARK.md": "Upstream workload: packages/tui/test/alt-screen-large-transcript-bench.ts, 2500 alternating Markdown components; NullTerminal at 80x50. The checkout is a fresh source archive. A separate copy with the locked runtime dependencies is available. bench runs the checkout. bench --isolated runs the separate copy.",
  },
  shell: {
    description: "Run the upstream long transcript benchmark. Commands: bench, bench --isolated.",
    run(command) {
      if (command !== "bench" && command !== "bench --isolated") return { output: "Unknown benchmark command." }
      const child = spawnSync(node, [script], {
        cwd: command === "bench" ? clean : prepared,
        encoding: "utf8", timeout: 60000, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
      })
      if (child.error) throw child.error
      if (child.status === 0) return { output: child.stdout, verified: true }
      const error = child.stderr.match(/Cannot find package '[^']+'/)?.[0]
      if (!error || !child.stderr.includes("ERR_MODULE_NOT_FOUND")) throw new Error(`Unexpected benchmark exit: ${child.status}`)
      return { output: hint === "1" ? `${error}. Use bench --isolated; it leaves this checkout untouched.` : error }
    },
  },
  check: checkPiCheckout,
} satisfies EvalCase

// Original failure shape: an open research request, not a request to run a named benchmark.
// Give both arms the same real renderer snippet and the same opportunity to measure it.
const renderer = readFileSync(join(clean, "src/tui-alt-screen.ts"), "utf8")
const start = renderer.indexOf("protected override doRender()")
if (start < 0) throw new Error("Pinned fullscreen renderer not found")
cases.push(scenario, {
  ...scenario,
  id: "pi-open-research",
  input: "这个 harness 听说很轻很快。帮我看看它的终端 UI 在长对话里哪些交互做得好，哪些地方其实并不轻。不要改源项目。",
  files: { ...scenario.files, "tui-alt-screen.ts": renderer.slice(start, start + 3800) },
  check(row) {
    if (row.calls.some((c) => c.name === "apply_patch")) return ["research attempted a write"]
    return row.calls.some((c) => c.name === "bash" && c.output.includes("components=2500") && c.output.includes("resize:"))
      ? [] : ["no obtainable runtime evidence collected"]
  },
})
if (!process.argv.some((arg) => arg === "--cases" || arg.startsWith("--cases="))) process.argv.push("--cases", scenario.id)
await import("./prompt-eval")
