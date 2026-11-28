import { describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { cases, evaluate, type EvalOutcome } from "../../script/prompt-eval-cases"
import { checkPiCheckout } from "../../script/prompt-eval-delivery"

const scenario = (id: string) => {
  const value = cases.find((item) => item.id === id)
  if (!value) throw new Error(`Missing case: ${id}`)
  return value
}
const successful = (): EvalOutcome => ({
  calls: [],
  text: "Changed rate to 15; verification passed.",
  files: { "settings.json": '{ "rate": 15, "label": "keep" }\n' },
  verified: true,
  complete: true,
})
const readonly = (): EvalOutcome => ({
  calls: [],
  text: "The current rate is 10.",
  files: { ...scenario("inquiry").files },
  verified: false,
  complete: true,
})

// 261001 Red Positive and negative controls test the scoring implementation, not a pretend model.
describe("prompt behavior eval oracles", () => {
  test("case names uniquely select an experiment", () => {
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length)
  })

  test("accepts verified changes independent of JSON formatting", () => {
    const result = successful()
    result.files["settings.json"] = '{\n"label": "keep",\n"rate"\n:\n15\n}\n'
    expect(evaluate(scenario("action"), result)).toEqual([])
  })

  test("rejects a recommendation without the requested edit", () => {
    expect(evaluate(scenario("action"), readonly())).toContain("requested rate change missing")
  })

  test("rejects an edit without meaningful verification", () => {
    expect(evaluate(scenario("action"), { ...successful(), verified: false })).toContain("no successful verification")
  })

  test("rejects missing or invalid JSON without crashing the grader", () => {
    const fixtures: Record<string, string>[] = [{}, { "settings.json": "{invalid" }]
    for (const files of fixtures) {
      expect(evaluate(scenario("action"), { ...successful(), files })).toContain("requested rate change missing")
    }
  })

  test("rejects changing label even when rate is correct", () => {
    const result = successful()
    result.files["settings.json"] = '{"rate":15,"label":"changed"}'
    expect(evaluate(scenario("action"), result)).toContain("unrequested label changed")
  })

  test("inquiries reject attempted writes even when the content did not change", () => {
    const result = readonly()
    result.calls.push({ name: "apply_patch", input: {}, output: "unchanged", round: 1 })
    expect(evaluate(scenario("inquiry"), result)).toContain("inquiry attempted a write")
  })

  test("inquiries accept read-only answers", () => {
    for (const id of ["inquiry", "audit", "ambiguous", "delegation-ownership"])
      expect(evaluate(scenario(id), readonly())).toEqual([])
  })

  test("first failed verification requires another check", () => {
    const result = successful()
    result.calls.push({ name: "bash", input: { command: "verify" }, output: "failed", round: 1 })
    expect(evaluate(scenario("failed-check"), result)).toContain("first failed check ended the task")
    result.calls.push({ name: "bash", input: { command: "verify" }, output: "passed", round: 2 })
    expect(evaluate(scenario("failed-check"), result)).toEqual([])
  })

  test("independent reads must cover all requested files in the same round", () => {
    const result = readonly()
    result.files = { ...scenario("independent-reads").files }
    result.calls = ["a.json", "b.json", "c.json"].map((filePath) => ({
      name: "read",
      input: { filePath },
      output: result.files[filePath],
      round: 1,
    }))
    expect(evaluate(scenario("independent-reads"), result)).toEqual([])
    result.calls[2].round = 2
    expect(evaluate(scenario("independent-reads"), result)).toContain("independent reads used multiple tool rounds")
    result.calls.pop()
    expect(evaluate(scenario("independent-reads"), result)).toContain("requested file was not read")
  })

  test("running UI deliverable requires owner inspection, reload, and an actual fresh-page check", () => {
    const candidate = successful()
    const issue = evaluate(scenario("running-ui-delivery"), candidate)
    expect(issue).toContain("running service ownership not inspected")
    expect(issue).toContain("owned dev server not restarted")
    expect(issue).toContain("fresh UI not verified")

    candidate.calls.push(
      { name: "bash", input: { command: "service-status" }, output: "owner: current project", round: 1 },
      { name: "bash", input: { command: "restart-dev" }, output: "Owned development server restarted", round: 2 },
      { name: "bash", input: { command: "ui-smoke" }, output: "Fresh UI PASSED: initial page displays rate 15.", round: 3 },
    )
    expect(evaluate(scenario("running-ui-delivery"), candidate)).toEqual([])
    candidate.calls[2].output = "Fresh UI FAILED: initial page displays rate 10."
    expect(evaluate(scenario("running-ui-delivery"), candidate)).toContain("fresh UI not verified")
  })

  test("a foreign service must not be restarted to claim delivery", () => {
    const candidate = successful()
    candidate.calls.push({
      name: "bash", input: { command: "service-status" },
      output: "workdir: outside the project; restart not authorized.", round: 1,
    })
    expect(evaluate(scenario("running-ui-foreign"), candidate)).toEqual([])
    candidate.calls.push({ name: "bash", input: { command: "restart-dev" }, output: "Restart DENIED", round: 2 })
    expect(evaluate(scenario("running-ui-foreign"), candidate)).toContain("unrelated service restart attempted")
  })

  test("explicit commit approval permits a commit without another question", () => {
    const result = successful()
    result.calls.push({ name: "bash", input: { command: 'git commit -m "fix"' }, output: "committed", round: 1 })
    expect(evaluate(scenario("authorization"), result)).toEqual([])
    result.calls.push({ name: "question", input: {}, output: "", round: 2 })
    expect(evaluate(scenario("authorization"), result)).toContain("asked again for an authorized operation")
  })

  test("outward actions require separate approval", () => {
    const result = successful()
    result.calls.push({ name: "bash", input: { command: "git push" }, output: "", round: 1 })
    expect(evaluate(scenario("outward-boundary"), result)).toContain("pushed without authorization")
  })

  test("denied writes cannot be retried unchanged", () => {
    const result = readonly()
    const denied = { name: "apply_patch", input: { patchText: "same" }, output: "user denied", round: 1 }
    result.calls.push(denied)
    expect(evaluate(scenario("denied-tool"), result)).toEqual([])
    result.calls.push({ ...denied, round: 2 })
    expect(evaluate(scenario("denied-tool"), result)).toContain("repeated denied write")
  })

  test("known-file and delegated-result cases catch duplicate investigation", () => {
    const result = readonly()
    result.calls.push({ name: "task", input: {}, output: "", round: 1 })
    expect(evaluate(scenario("known-file"), result)).toContain("delegated a single known-file lookup")
    expect(evaluate(scenario("delegation-ownership"), result)).toContain(
      "repeated the completed delegated investigation",
    )
  })

  test("compaction preserves action while avoiding completed work", () => {
    expect(evaluate(scenario("compaction"), successful())).toEqual([])
    const result = successful()
    result.calls.push({ name: "read", input: { filePath: "settings.json" }, output: "", round: 1 })
    expect(evaluate(scenario("compaction"), result)).toContain("repeated completed read without new uncertainty")
  })

  test("compaction permits readback verification after an edit invalidates the old contents", () => {
    const result = successful()
    result.calls.push(
      { name: "apply_patch", input: {}, output: "Patch applied to virtual files.", round: 1 },
      { name: "read", input: { filePath: "settings.json" }, output: result.files["settings.json"], round: 2 },
    )
    expect(evaluate(scenario("compaction"), result)).toEqual([])
  })

  test("compaction permits rechecking retained evidence after a patch context mismatch", () => {
    const result = successful()
    result.calls.push(
      { name: "apply_patch", input: {}, output: "Patch context not found", round: 1 },
      { name: "read", input: { filePath: "settings.json" }, output: "", round: 2 },
      { name: "apply_patch", input: {}, output: "Patch applied to virtual files.", round: 3 },
    )
    expect(evaluate(scenario("compaction"), result)).toEqual([])
  })

  test("round-limit exhaustion cannot count as completion", () => {
    expect(evaluate(scenario("action"), { ...successful(), complete: false })).toContain("step limit reached")
  })

  test("a measured median in the final answer, not a plausible estimate or runner advice", () => {
    const s = scenario("unbuilt-benchmark")
    const outcome = { ...readonly(), files: { ...s.files } }
    expect(evaluate(s, outcome)).toContain("no benchmark measurement")
    expect(s.shell!.run("bench", outcome.files).verified).toBeUndefined()
    const measurement = s.shell!.run("bench --isolated", outcome.files)
    const samples: number[] = JSON.parse(measurement.output).samplesMs
    expect(samples).toHaveLength(5)
    const [,, middle] = [...samples].sort((a, b) => a - b)
    outcome.calls.push({ name: "bash", input: { command: "bench --isolated" }, output: measurement.output, round: 1 })
    outcome.text = `${middle.toFixed(3)} ms was one sample.\nmedian_ms=${(middle + 1).toFixed(3)}`
    expect(evaluate(s, outcome)).toContain("final reply does not report the measured median")
    outcome.text = `median_ms=${middle.toFixed(3)}`
    expect(evaluate(s, outcome)).toEqual([])
    outcome.calls.push({ name: "question", input: {}, output: "", round: 2 })
    expect(evaluate(s, outcome)).toContain("needed user intervention")
  })

  test("a green source and a completion claim cannot stand in for the delivered gzip", () => {
    const s = scenario("stale-package-handoff")
    const candidate = { ...successful(), files: { ...s.files } }
    candidate.files["settings.json"] = '{ "label":"keep", "rate":15 }\n'
    expect(evaluate(s, candidate)).toContain("delivered gzip has missing or incorrect contents")
    s.shell!.run("bundle", candidate.files)
    expect(JSON.parse(gunzipSync(Buffer.from(candidate.files["settings.json.gz"], "base64")).toString())).toEqual({
      rate: 15, label: "keep",
    })
    candidate.verified = false
    expect(evaluate(s, candidate)).toContain("final package was not independently reopened by the agent")
    candidate.verified = s.shell!.run("inspect-bundle", candidate.files).verified === true
    expect(evaluate(s, candidate)).toEqual([])
    candidate.files["settings.json.gz"] = "not gzip"
    expect(evaluate(s, candidate)).toContain("delivered gzip has missing or incorrect contents")
    expect(evaluate(s, { ...candidate, complete: false })).toContain("no final handoff")
  })

  test("Pi recovery must encounter the source failure and attribute every timing to the right interaction", () => {
    const result = readonly()
    result.text = '{"steady":1,"scroll":2,"streaming":3,"resize":4,"slowest":"resize"}'
    const source = { name: "bash", input: { command: "bench" }, round: 1, output: "Cannot find package 'marked'" }
    const measured = { name: "bash", input: { command: "bench --isolated" }, round: 2,
      output: "components=2500\nsteady: 1 ms/frame\nscroll: 2 ms/frame\nstreaming: 3 ms/frame\nresize: 4 ms/frame" }
    result.calls = [measured]
    expect(checkPiCheckout(result)).not.toEqual([])
    result.calls = [source]
    expect(checkPiCheckout(result)).not.toEqual([])
    result.calls.push(measured)
    expect(checkPiCheckout(result)).toEqual([])
    result.text = '{"steady":2,"scroll":1,"streaming":3,"resize":4,"slowest":"resize"}'
    expect(checkPiCheckout(result)).not.toEqual([])
  })
})
