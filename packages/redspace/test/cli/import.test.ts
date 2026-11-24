import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import {
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})

cliIt.live("an invalid final part rolls back the entire import and the corrected file can be retried", ({ home, redcode }) =>
  Effect.gen(function* () {
    const dbPath = path.join(home, "import.db")
    const file = path.join(home, "session.json")
    const options = { env: { REDCODE_DB: dbPath } }
    const sessionID = "ses_import_atomic"
    const messageID = "msg_import_atomic"
    const text = { id: "prt_import_first", sessionID, messageID, type: "text", text: "original" }
    const info = { id: sessionID, title: "restore", slug: "restore", version: "1", time: { created: 1, updated: 1 } }
    const message = {
      id: messageID, sessionID, role: "user", time: { created: 1 }, agent: "build",
      model: { providerID: "test", modelID: "test" },
    }
    const archive = (parts: unknown[]) => JSON.stringify({ info, messages: [{ info: message, parts }] })
    yield* Effect.promise(() => Bun.write(file, archive([text, { ...text, id: "prt_import_last", type: "unknown" }])))
    const failed = yield* redcode.spawn(["import", file], options)
    expect(failed.exitCode).not.toBe(0)

    const rows = () => {
      using db = new Database(dbPath, { readonly: true })
      return ["session", "message", "part"].map((table) =>
        db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n,
      )
    }
    expect(rows()).toEqual([0, 0, 0])
    yield* Effect.promise(() => Bun.write(file, archive([text, { ...text, id: "prt_import_last" }])))
    redcode.expectExit(yield* redcode.spawn(["import", file], options), 0)
    expect(rows()).toEqual([1, 1, 2])
  }),
  90_000,
)
