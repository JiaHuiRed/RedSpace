import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Parameters as ApplyPatch } from "../../src/tool/apply_patch"
import { Parameters as Edit } from "../../src/tool/edit"
import { Parameters as Glob } from "../../src/tool/glob"
import { Parameters as Grep } from "../../src/tool/grep"
import { Parameters as Image } from "../../src/tool/image"
import { Parameters as Invalid } from "../../src/tool/invalid"
import { Parameters as Lsp } from "../../src/tool/lsp"
import { Parameters as Plan } from "../../src/tool/plan"
import { Parameters as Question } from "../../src/tool/question"
import { Parameters as Read, ReadJsonSchema } from "../../src/tool/read"
import { Parameters as Shell } from "../../src/tool/shell"
import { Parameters as Skill } from "../../src/tool/skill"
import { Parameters as Task } from "../../src/tool/task"
import { Parameters as Todo } from "../../src/tool/todo"
import { Parameters as WebFetch } from "../../src/tool/webfetch"
import { Parameters as WebSearch } from "../../src/tool/websearch"
import { Parameters as Write } from "../../src/tool/write"

const accepts = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))
const toJsonSchema = ToolJsonSchema.fromSchema

describe("tool parameters", () => {
  describe("JSON Schema (wire shape)", () => {
    test("apply_patch", () => expect(toJsonSchema(ApplyPatch)).toMatchSnapshot())
    test("bash", () => expect(toJsonSchema(Shell)).toMatchSnapshot())
    test("edit", () => expect(toJsonSchema(Edit)).toMatchSnapshot())
    test("glob", () => expect(toJsonSchema(Glob)).toMatchSnapshot())
    test("grep", () => expect(toJsonSchema(Grep)).toMatchSnapshot())
    test("image", () => expect(toJsonSchema(Image)).toMatchSnapshot())
    test("invalid", () => expect(toJsonSchema(Invalid)).toMatchSnapshot())
    test("lsp", () => expect(toJsonSchema(Lsp)).toMatchSnapshot())
    test("plan", () => expect(toJsonSchema(Plan)).toMatchSnapshot())
    test("question", () => expect(toJsonSchema(Question)).toMatchSnapshot())
    test("read", () => expect(ReadJsonSchema).toMatchSnapshot())
    test("skill", () => expect(toJsonSchema(Skill)).toMatchSnapshot())
    test("task", () => expect(toJsonSchema(Task)).toMatchSnapshot())
    test("todo", () => expect(toJsonSchema(Todo)).toMatchSnapshot())
    test("webfetch", () => expect(toJsonSchema(WebFetch)).toMatchSnapshot())
    test("websearch", () => expect(toJsonSchema(WebSearch)).toMatchSnapshot())
    test("write", () => expect(toJsonSchema(Write)).toMatchSnapshot())

    test("preserves required nullable fields", () => {
      expect(toJsonSchema(Schema.Struct({ value: Schema.NullOr(Schema.String) }))).toMatchObject({
        required: ["value"],
        properties: { value: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
      })
    })

    test("bounds bare integer fields to safe integer range", () => {
      expect(toJsonSchema(Schema.Struct({ value: Schema.Int }))).toMatchObject({
        properties: { value: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
      })
    })
  })

  test("image requires a bounded prompt", () => {
    expect(accepts(Image, { prompt: "" })).toBe(false)
    expect(accepts(Image, { prompt: "x".repeat(8193) })).toBe(false)
  })

  test("accepts hashline input without a separate filePath", () => {
    expect(accepts(Edit, { input: "[a.ts#TAG]\nreplace 1..1:\n+ x" })).toBe(true)
  })

  test("lsp positions start at one", () => {
    expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: 0, character: 1 })).toBe(false)
    expect(accepts(Lsp, { operation: "hover", filePath: "/a.ts", line: 1, character: 0 })).toBe(false)
  })

  describe("read", () => {
    test("accepts unambiguous line-range arguments", () => {
      const parse = Schema.decodeUnknownSync(Read)
      expect(parse({ filePath: "/a", offset: " 10 ", limit: [5] })).toEqual({ filePath: "/a", offset: 10, limit: 5 })
      expect(parse({ filePath: "/a", offset: ["2"], limit: "3" })).toEqual({ filePath: "/a", offset: 2, limit: 3 })
    })
    test("rejects ambiguous or invalid line-range arguments", () => {
      for (const value of [null, true, "", "1e3", "1.5", "-1", "9007199254740993", [], [1, 2], [[1]]]) {
        expect(accepts(Read, { filePath: "/a", limit: value })).toBe(false)
      }
    })
  })
})
