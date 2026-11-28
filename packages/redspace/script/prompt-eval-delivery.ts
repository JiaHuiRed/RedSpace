import { gzipSync, gunzipSync } from "node:zlib"
import { estimateReporting } from "../src/util/token"
import type { EvalCase, EvalOutcome } from "./prompt-eval-cases"

const corpus = "function total(items) { return items.length } // 数量\n".repeat(4096)

function sample() {
  const start = performance.now()
  const tokens = estimateReporting(corpus)
  return { ms: Number((performance.now() - start).toFixed(3)), tokens }
}

const archive = "settings.json.gz"
const original = '{"rate":10,"label":"keep"}\n'

function unpack(files: Record<string, string>) {
  try {
    return gunzipSync(Buffer.from(files[archive] ?? "", "base64"), { maxOutputLength: 65536 }).toString("utf8")
  } catch {
    // The candidate can edit or remove the virtual archive; invalid gzip is a failed delivery.
    return undefined
  }
}

function requested(text: string | undefined) {
  if (!text) return false
  try {
    const value = JSON.parse(text)
    return value?.rate === 15 && value?.label === "keep" && Object.keys(value).length === 2
  } catch {
    // Invalid candidate JSON is an incorrect artifact, not a grader error.
    return false
  }
}

export const deliveryCases: EvalCase[] = [
  {
    // Pi investigation: the checkout had no build; the first handoff omitted the available local measurement.
    id: "unbuilt-benchmark",
    input: "这个没装依赖的 checkout 里，帮我实测 reporting estimator 的耗时。五次样本的中位数单独写一行 median_ms=数值，保留三位小数；不要改项目。",
    files: {
      "README.md": "bench uses the installed distribution. bench --isolated runs the same benchmark using the bundled source runner without installing anything. Both use one warmup and five measurements.",
    },
    shell: {
      description: "Run a benchmark as documented in README.md. The checkout has no installed distribution.",
      run(command) {
        if (command === "bench") return { output: "Distribution not built; see README.md for the offline runner." }
        if (command !== "bench --isolated") return { output: "Unknown benchmark command; see README.md." }
        sample()
        const samples = Array.from({ length: 5 }, () => sample())
        return { output: JSON.stringify({ samplesMs: samples.map((s) => s.ms), tokens: samples[0].tokens }), verified: true }
      },
    },
    check(outcome) {
      const call = outcome.calls.findLast((c) => c.name === "bash" && String(c.input.command).trim() === "bench --isolated")
      if (!call) return ["no benchmark measurement"]
      const { samplesMs } = JSON.parse(call.output) as { samplesMs: number[] }
      const median = samplesMs.toSorted((a, b) => a - b)[2].toFixed(3)
      const reported = outcome.text.split(/\r?\n/).map((line) => line.replace(/[*`]/g, "").trim())
        .filter((line) => line.startsWith("median_ms="))
      return [
        ...(reported.length === 1 && reported[0] === `median_ms=${median}` ? [] : ["final reply does not report the measured median"]),
        ...(outcome.calls.some((c) => c.name === "apply_patch") ? ["read-only benchmark attempted a write"] : []),
      ]
    },
  },
  {
    // Empty-diff implementation handoff and source-only package delivery: inspect what the consumer actually opens.
    id: "stale-package-handoff",
    input: "接手上个同事交付的配置包。用户解压后 rate 要是 15，原有 label 不变。检查一下，有问题直接修好，交付可用的 settings.json.gz。",
    files: {
      "handoff.txt": "Previous implementer: completed the rate change and rebuilt the package. Ready for delivery.",
      "BUILD.md": "settings.json is the source. `bundle` packages its current contents into settings.json.gz. `inspect-bundle` decompresses the package and prints the exact contents a consumer receives.",
      "settings.json": original,
      [archive]: gzipSync(original).toString("base64"),
    },
    shell: {
      description: "Package commands are documented in BUILD.md. Binary files in the virtual tree use base64.",
      run(command, files) {
        if (command === "inspect-bundle") {
          const contents = unpack(files)
          return { output: contents ?? "Could not decompress settings.json.gz", verified: requested(contents) }
        }
        if (command !== "bundle") return { output: "Unknown package command; see BUILD.md." }
        if (files["settings.json"] === undefined) return { output: "Cannot bundle: missing settings.json." }
        files[archive] = gzipSync(files["settings.json"]).toString("base64")
        return { output: "Built settings.json.gz." }
      },
    },
    artifact: archive,
    check(outcome) {
      return [
        ...(requested(outcome.files["settings.json"]) ? [] : ["source settings incorrect"]),
        ...(requested(unpack(outcome.files)) ? [] : ["delivered gzip has missing or incorrect contents"]),
        ...(outcome.verified ? [] : ["final package was not independently reopened by the agent"]),
      ]
    },
  },
]

export function checkPiCheckout(row: EvalOutcome) {
  if (row.calls.some((c) => c.name === "apply_patch")) return ["read-only checkout attempted a write"]
  const probes = row.calls.filter((c) => c.name === "bash")
  const miss = probes.findIndex((c) => String(c.input.command).trim() === "bench" && c.output.includes("Cannot find package"))
  if (miss === -1) return ["did not exercise the missing-dependency path on the source checkout"]
  const stdout = probes.slice(miss + 1).findLast((c) =>
    String(c.input.command).trim() === "bench --isolated" && c.output.includes("components=2500"),
  )?.output
  if (!stdout) return ["no real upstream benchmark run"]
  const measured = Object.fromEntries(
    [...stdout.matchAll(/^(steady|scroll|streaming|resize): ([\d.]+) ms\/frame/gm)].map((m) => [m[1], Number(m[2])]),
  )
  const names = Object.keys(measured)
  if (names.length !== 4) throw new Error("Incomplete upstream benchmark")
  const text = row.text.match(/\{[^{}]*\}/g)?.at(-1)
  if (!text) return ["no parseable final measurements"]
  let reported
  try {
    reported = JSON.parse(text)
  } catch {
    return ["invalid measurements JSON"]
  }
  const slowest = names.reduce((a, b) => measured[a] > measured[b] ? a : b)
  return names.every((n) => measured[n] === reported?.[n]) && reported?.slowest === slowest
    ? [] : ["wrong final measurements or slowest condition"]
}
