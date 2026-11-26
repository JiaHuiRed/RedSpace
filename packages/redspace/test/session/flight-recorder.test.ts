import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import * as Flight from "@/session/flight-recorder"
import { FlightRequestTable } from "@/session/flight-request.sql"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { MessageTable, PartTable } from "@/session/session.sql"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

// Insert the historical wire shape directly: missing fields must remain unknown on read.
function message(session: SessionID, extra: Record<string, unknown> = {}) {
  const id = MessageID.ascending()
  const data = { role: "assistant", providerID: "provider", modelID: "model/one", ...extra }
  Database.use((db) =>
    db.run(sql`insert into ${MessageTable} (id, session_id, time_created, time_updated, data)
    values (${id}, ${session}, 1, 1, ${JSON.stringify(data)})`),
  )
  return id
}

function part(session: SessionID, message: MessageID, time: number, data: object) {
  const id = PartID.ascending()
  Database.use((db) =>
    db.run(sql`insert into ${PartTable} (id, message_id, session_id, time_created, time_updated, data)
    values (${id}, ${message}, ${session}, ${time}, ${time}, ${JSON.stringify(data)})`),
  )
  return id
}

it.instance("pages steps on the active branch without reading conversation or substituting message totals", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { id } = yield* sessions.create({})
    const other = (yield* sessions.create({})).id
    const m = message(id, { tokens: { context: 999999 } })
    const recorded = {
      type: "step-finish",
      cost: 0.25,
      currency: "CNY",
      tokens: { context: 100, input: 7, output: 10, reasoning: 2, cache: { read: 90, write: 3, miss: 7 } },
    }
    const legacy = part(id, m, 10, { type: "step-finish", cost: 0, tokens: { input: 8, output: 1 } })
    const old = part(id, m, 20, recorded)
    const tied = part(id, m, 20, { ...recorded, estimated: true })
    part(id, m, 30, { type: "tool", state: { output: "PRIVATE-FIXTURE-TEXT" } })
    part(id, message(id, { detached: 1 }), 40, recorded)
    part(other, message(other), 50, recorded)

    const first = Flight.page(id, "steps", 2)!
    expect(first.items.map((r) => r.id)).toEqual([tied, old])
    expect(first.items[0]?.outcome).toBe("estimated")
    expect(first.items[0]?.input).toBeUndefined()
    expect(first.items[0]?.cacheRead).toBeUndefined()
    expect(first.items[1]).toMatchObject({
      messageID: m,
      time: 20,
      outcome: "booked",
      modelID: "model/one",
      input: 100,
      output: 12,
      cacheRead: 90,
      cacheWrite: 3,
      cacheMiss: 7,
      cost: 0.25,
      currency: "CNY",
    })
    expect(JSON.stringify(first)).not.toContain("PRIVATE-FIXTURE-TEXT")
    part(id, m, 21, recorded)
    const next = Flight.page(id, "steps", 2, first.next)!
    expect(next.items.map((r) => r.id)).toEqual([legacy])
    expect(next.next).toBeUndefined()
    expect(next.items[0]?.input).toBeUndefined()
    expect(next.items[0]?.cacheRead).toBeUndefined()
    expect(next.items[0]?.cost).toBe(0)
    expect(Flight.page(id, "requests")).toEqual({ items: [] })
    expect(Flight.page(other, "steps", 2, first.next)).toBeUndefined()
    expect(Flight.page(id, "requests", 2, first.next)).toBeUndefined()
    expect(Flight.page(id, "steps", 2, "not a cursor")).toBeUndefined()
  }),
)

it.instance("request history keeps attempts distinct, preserves explicit zero, and never borrows step usage", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { id } = yield* sessions.create({})
    const m = message(id, { summary: true })
    const base = { session_id: id, message_id: m, provider_id: "p", model_id: "m", time_created: 100 }
    Database.use((db) =>
      db
        .insert(FlightRequestTable)
        .values([
          { ...base, id: "req_a", data: { outcome: "failed" } },
          {
            ...base,
            id: "req_b",
            data: {
              outcome: "completed",
              input: 100,
              cacheRead: 0,
              prefix: { system: "rewrite", tools: "unchanged", history: "append", compressed: false },
            },
          },
          { ...base, message_id: message(id, { detached: 1 }), id: "req_hidden", data: { outcome: "completed" } },
        ])
        .run(),
    )
    const first = Flight.page(id, "requests", 1)!
    expect(first.items[0]).toMatchObject({
      id: "req_b",
      messageID: m,
      summary: true,
      outcome: "completed",
      input: 100,
      cacheRead: 0,
      prefix: { system: "rewrite", tools: "unchanged", history: "append", compressed: false },
    })
    const last = Flight.page(id, "requests", 1, first.next)!
    expect(last.items[0]).toMatchObject({ id: "req_a", outcome: "failed" })
    expect(last.items[0]?.cacheRead).toBeUndefined()
    expect(last.items[0]?.prefix).toBeUndefined()
    expect(last.next).toBeUndefined()
    expect(Flight.page(id, "steps")).toEqual({ items: [] })
  }),
)
