import { expect } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { WorkspaceID } from "@/control-plane/schema"
import { InstanceState } from "@/effect/instance-state"
import { ProjectID } from "@/project/schema"
import { Database } from "@/storage/db"
import * as Flight from "@/session/flight-recorder"
import * as FlightRequestWriter from "@/session/flight-request-writer"
import { FlightRequestTable } from "@/session/flight-request.sql"
import type { RequestData } from "@/session/flight-recording"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageTable, PartTable } from "@/session/session.sql"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

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

function request(
  session: SessionID,
  message: MessageID,
  id: string,
  time: number,
  data: RequestData,
  providerID = "provider",
  modelID = "model/one",
) {
  Database.use((db) =>
    db
      .insert(FlightRequestTable)
      .values({
        id,
        session_id: session,
        message_id: message,
        time_created: time,
        provider_id: providerID,
        model_id: modelID,
        data,
      })
      .run(),
  )
}

type RequestInsert = {
  id: string
  session_id: SessionID
  message_id: MessageID
  time_created: number
  provider_id: string
  model_id: string
  data: RequestData
}

function requests(rows: RequestInsert[]) {
  Database.use((db) => {
    for (let index = 0; index < rows.length; index += 200) {
      db.insert(FlightRequestTable)
        .values(rows.slice(index, index + 200))
        .run()
    }
  })
}

function steps(rows: { session: SessionID; message: MessageID; time: number; data: object }[]) {
  Database.use((db) => {
    for (let index = 0; index < rows.length; index += 100) {
      const chunk = rows.slice(index, index + 100)
      db.run(sql`insert into part (id, message_id, session_id, time_created, time_updated, data)
        values ${sql.join(
          chunk.map(
            (row) =>
              sql`(${PartID.ascending()}, ${row.message}, ${row.session}, ${row.time}, ${row.time}, ${JSON.stringify(row.data)})`,
          ),
          sql`, `,
        )}`)
    }
  })
}

// 261126 Red 全局聚合必须只按实例项目作用域读。这里直接种一个别的项目，证明查询不会
// 跨项目扫出内容，也方便验证同一形状的数据在目标项目里仍然可见。
function foreignProjectStep(time: number) {
  const projectID = ProjectID.make("other-project-global")
  const sessionID = SessionID.descending()
  const messageID = MessageID.ascending()
  Database.use((db) =>
    db.run(sql`insert into project (id, worktree, sandboxes, time_created, time_updated)
      values (${projectID}, '/other', '[]', 1, 1)`),
  )
  Database.use((db) =>
    db.run(sql`insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
      values (${sessionID}, ${projectID}, ${sessionID}, '/other', 'Other project', '0', 1, 1)`),
  )
  Database.use((db) =>
    db.run(sql`insert into message (id, session_id, time_created, time_updated, data)
      values (${messageID}, ${sessionID}, 1, 1, ${JSON.stringify({ role: "assistant", providerID: "other", modelID: "other" })})`),
  )
  part(sessionID, messageID, time, {
    type: "step-finish",
    cost: 99,
    currency: "USD",
    tokens: { context: 1, output: 1, cache: { read: 0 } },
  })
  return { projectID, sessionID, messageID }
}

function foreignFlightRows(count: number, start: number) {
  const projectID = ProjectID.make(`foreign-scope-${start}`)
  const sessionID = SessionID.descending()
  const messageID = MessageID.ascending()
  Database.use((db) =>
    db.run(sql`insert into project (id, worktree, sandboxes, time_created, time_updated)
      values (${projectID}, ${`/foreign/${start}`}, '[]', 1, 1)`),
  )
  Database.use((db) =>
    db.run(sql`insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
      values (${sessionID}, ${projectID}, ${sessionID}, '/foreign', 'Foreign scope', '0', 1, 1)`),
  )
  Database.use((db) =>
    db.run(sql`insert into message (id, session_id, time_created, time_updated, data)
      values (${messageID}, ${sessionID}, 1, 1, ${JSON.stringify({
        role: "assistant",
        providerID: "foreign",
        modelID: "foreign",
      })})`),
  )
  requests(
    Array.from({ length: count }, (_, index) => ({
      id: `foreign_req_${start}_${index}`,
      session_id: sessionID,
      message_id: messageID,
      time_created: start + index,
      provider_id: "foreign",
      model_id: "foreign",
      data: { outcome: "completed" as const },
    })),
  )
  steps(
    Array.from({ length: count }, (_, index) => ({
      session: sessionID,
      message: messageID,
      time: start + index,
      data: { type: "step-finish", tokens: { context: 1, output: 1 } },
    })),
  )
  return { projectID, sessionID, messageID }
}

it.instance("pages steps on the active branch without reading conversation or substituting message totals", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
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

    const scope = { projectID: instance.project.id }
    const first = Flight.page(id, scope, "steps", 2)!
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
    const next = Flight.page(id, scope, "steps", 2, first.next)!
    expect(next.items.map((r) => r.id)).toEqual([legacy])
    expect(next.next).toBeUndefined()
    expect(next.items[0]?.input).toBeUndefined()
    expect(next.items[0]?.cacheRead).toBeUndefined()
    expect(next.items[0]?.cost).toBe(0)
    expect(Flight.page(id, scope, "requests")).toEqual({ items: [] })
    expect(Flight.page(other, scope, "steps", 2, first.next)).toBeUndefined()
    expect(Flight.page(id, scope, "requests", 2, first.next)).toBeUndefined()
    expect(Flight.page(id, scope, "steps", 2, "not a cursor")).toBeUndefined()
  }),
)

it.instance("request history keeps attempts distinct, preserves explicit zero, and never borrows step usage", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const { id } = yield* sessions.create({})
    const m = message(id, { summary: true })
    const scope = { projectID: instance.project.id }
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
    const first = Flight.page(id, scope, "requests", 1)!
    expect(first.items[0]).toMatchObject({
      id: "req_b",
      messageID: m,
      summary: true,
      outcome: "completed",
      input: 100,
      cacheRead: 0,
      prefix: { system: "rewrite", tools: "unchanged", history: "append", compressed: false },
    })
    const last = Flight.page(id, scope, "requests", 1, first.next)!
    expect(last.items[0]).toMatchObject({ id: "req_a", outcome: "failed" })
    expect(last.items[0]?.cacheRead).toBeUndefined()
    expect(last.items[0]?.prefix).toBeUndefined()
    expect(last.next).toBeUndefined()
    expect(Flight.page(id, scope, "steps")).toEqual({ items: [] })
  }),
)

it.instance("global summary keeps both ledgers separate, counts owners once, and only rates valid cache samples", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const main = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: main.id })
    const workspace = yield* sessions.create({ workspaceID: WorkspaceID.make("wrk_flight_global") })
    const mainMessage = message(main.id, { providerID: "p-main", modelID: "m-one" })
    const childMessage = message(child.id, { providerID: "p-child", modelID: "m-one" })
    const workspaceMessage = message(workspace.id, { providerID: "p-ws", modelID: "m-two" })
    const detached = message(main.id, { detached: 1, providerID: "p-main", modelID: "m-one" })

    part(main.id, mainMessage, 10, {
      type: "step-finish",
      cost: 0.25,
      currency: "USD",
      tokens: { context: 100, output: 10, cache: { read: 90, write: 5, miss: 10 } },
    })
    part(main.id, mainMessage, 11, {
      type: "step-finish",
      cost: 0.5,
      currency: "USD",
      estimated: true,
      tokens: { output: 4 },
    })
    part(child.id, childMessage, 12, {
      type: "step-finish",
      cost: 1,
      currency: "CNY",
      tokens: { context: 200, output: 20, cache: { read: 200 } },
    })
    part(workspace.id, workspaceMessage, 13, {
      type: "step-finish",
      tokens: { context: 50, output: 5, cache: { read: 10 } },
    })
    // read > input：矛盾样本进入 invalid，不参与 Σread/Σinput，但 input 仍计入原始总量。
    part(main.id, mainMessage, 14, {
      type: "step-finish",
      cost: 0,
      currency: "USD",
      tokens: { context: 100, output: 0, cache: { read: 120 } },
    })
    part(main.id, detached, 15, {
      type: "step-finish",
      cost: 7,
      currency: "USD",
      tokens: { context: 100, output: 1, cache: { read: 100 } },
    })
    const foreign = foreignProjectStep(16)

    request(
      main.id,
      mainMessage,
      "g_req_ok",
      20,
      {
        outcome: "completed",
        input: 100,
        cacheRead: 40,
        durationMs: 120,
        firstEventMs: 30,
      },
      "p-main",
      "m-one",
    )
    request(main.id, mainMessage, "g_req_fail", 21, { outcome: "failed" }, "p-main", "m-one")
    request(
      child.id,
      childMessage,
      "g_req_cancel",
      22,
      {
        outcome: "cancelled",
        input: 10,
        cacheRead: 10,
      },
      "p-child",
      "m-one",
    )
    request(
      workspace.id,
      workspaceMessage,
      "g_req_unknown",
      23,
      {
        outcome: "unknown",
        input: 5,
        cacheRead: 9,
        durationMs: 80,
      },
      "p-ws",
      "m-two",
    )
    request(main.id, detached, "g_req_hidden", 24, { outcome: "completed" }, "p-main", "m-one")
    request(foreign.sessionID, foreign.messageID, "g_req_foreign", 25, { outcome: "completed" }, "other", "other")

    const all = Flight.overview({ projectID: instance.project.id })!
    expect(all.steps.samples).toBe(5)
    expect(all.steps.sessions).toEqual({ main: 2, sub: 1 })
    expect(all.steps.outcomes).toEqual({ booked: 4, estimated: 1 })
    expect(all.steps.usage).toMatchObject({
      samples: 5,
      input: 450,
      output: 39,
      cacheRead: 420,
      cacheWrite: 5,
      cacheMiss: 10,
    })
    expect(all.steps.usage.cache).toMatchObject({ input: 350, read: 300, samples: 3 })
    expect(all.steps.usage.cache.hitRate).toBeCloseTo(300 / 350)
    expect(all.steps.usage.cache.excluded).toEqual({ invalid: 1, incomplete: 1 })
    expect(all.steps.cost.find((bucket) => bucket.currency === "USD")).toMatchObject({
      booked: 0.25,
      estimated: 0.5,
      samples: 3,
      missing: 0,
    })
    expect(all.steps.cost.find((bucket) => bucket.currency === "CNY")).toMatchObject({
      booked: 1,
      estimated: 0,
      samples: 1,
      missing: 0,
    })
    expect(all.steps.cost.find((bucket) => bucket.currency === null)).toMatchObject({
      booked: 0,
      estimated: 0,
      samples: 0,
      missing: 1,
    })

    expect(all.requests.samples).toBe(4)
    expect(all.requests.sessions).toEqual({ main: 2, sub: 1 })
    expect(all.requests.outcomes).toEqual({ completed: 1, failed: 1, cancelled: 1, unknown: 1 })
    expect(all.requests.usage.input).toBe(115)
    expect(all.requests.usage.cache).toMatchObject({ input: 110, read: 50, samples: 2 })
    expect(all.requests.usage.cache.hitRate).toBeCloseTo(50 / 110)
    expect(all.requests.usage.cache.excluded).toEqual({ invalid: 1, incomplete: 1 })
    expect(all.requests.latency).toEqual({
      samples: 2,
      durationMs: { p50: 80, p95: 120, max: 120 },
      firstEventMs: { p50: 30, p95: 30, max: 30 },
    })

    // 主子只按会话关系归属：workspace 会话没有 parent_id，仍记 main。
    expect(all.ownership.steps.main.samples).toBe(4)
    expect(all.ownership.steps.sub.samples).toBe(1)
    expect(all.ownership.requests.main.samples).toBe(3)
    expect(all.ownership.requests.sub.samples).toBe(1)

    const mainModel = all.models.find((group) => group.providerID === "p-main" && group.modelID === "m-one")!
    expect(mainModel.steps.samples).toBe(3)
    expect(mainModel.requests.samples).toBe(2)
    const local = all.workspaces.find((group) => group.workspaceID === null)!
    expect(local.steps.samples).toBe(4)
    expect(local.requests.samples).toBe(3)
    const workspaceGroup = all.workspaces.find((group) => group.workspaceID === "wrk_flight_global")!
    expect(workspaceGroup.steps.samples).toBe(1)
    expect(workspaceGroup.requests.samples).toBe(1)

    // 窗口是全局索引窗口，scanned/from/to 可以包含同库其他项目的行；本项目的样本数仍是 5/4。
    expect(all.coverage.steps).toMatchObject({ from: 10, to: 14, truncated: false })
    expect(all.coverage.steps.scanned).toBeGreaterThanOrEqual(5)
    expect(all.coverage.requests).toMatchObject({ from: 20, to: 23, truncated: false })
    expect(all.coverage.requests.scanned).toBeGreaterThanOrEqual(4)
    expect(all.truncated).toBe(false)
    expect(all.breakdownsTruncated).toBe(false)
    const retention = FlightRequestWriter.stats().limits
    expect(all.retention).toEqual({
      requestsPerSession: retention.requestsPerSession,
      totalRequests: retention.totalRequests,
      ...(retention.retentionMs === undefined ? {} : { retentionMs: retention.retentionMs }),
    })
    expect(all.retention.requestsPerSession).toBe(128)
    expect(all.retention.totalRequests).toBe(100_000)
    expect(all.daily).toHaveLength(1)
    expect(all.daily[0]?.steps.samples).toBe(5)
    expect(all.daily[0]?.requests.samples).toBe(4)

    const childOnly = Flight.overview({ projectID: instance.project.id }, { sessionID: child.id })!
    expect(childOnly.steps.samples).toBe(1)
    expect(childOnly.requests.samples).toBe(1)
    expect(childOnly.steps.sessions).toEqual({ main: 0, sub: 1 })
    expect(childOnly.requests.sessions).toEqual({ main: 0, sub: 1 })

    const workspaceOnly = Flight.overview(
      { projectID: instance.project.id },
      { workspaceID: WorkspaceID.make("wrk_flight_global") },
    )!
    expect(workspaceOnly.steps.samples).toBe(1)
    expect(workspaceOnly.requests.samples).toBe(1)
    expect(workspaceOnly.models.map((group) => group.providerID)).toEqual(["p-ws"])

    const ranged = Flight.overview({ projectID: instance.project.id }, { from: 12, to: 23 })!
    expect(ranged.steps.samples).toBe(3)
    expect(ranged.requests.samples).toBe(3)
    expect(ranged.coverage.steps).toMatchObject({ from: 12, to: 14, truncated: false })
    expect(ranged.coverage.steps.scanned).toBeGreaterThanOrEqual(3)
    expect(ranged.coverage.requests).toMatchObject({ from: 20, to: 22, truncated: false })
    expect(ranged.coverage.requests.scanned).toBeGreaterThanOrEqual(3)

    const providerOnly = Flight.overview({ projectID: instance.project.id }, { providerID: "p-main" })!
    expect(providerOnly.steps.samples).toBe(3)
    expect(providerOnly.requests.samples).toBe(2)
    // provider/model 在窗口内过滤；scanned 是过滤前实际检查的行数。
    expect(providerOnly.coverage.steps.scanned).toBeGreaterThanOrEqual(5)
    expect(providerOnly.coverage.requests.scanned).toBeGreaterThanOrEqual(4)

    const modelOnly = Flight.overview({ projectID: instance.project.id }, { modelID: "m-two" })!
    expect(modelOnly.steps.samples).toBe(1)
    expect(modelOnly.requests.samples).toBe(1)

    const foreignOnly = Flight.overview({ projectID: foreign.projectID })!
    expect(foreignOnly.steps.samples).toBe(1)
    expect(foreignOnly.requests.samples).toBe(1)
    expect(foreignOnly.steps.usage.input).toBe(1)
  }),
)

it.instance("global cache stats keep explicit zero apart from missing usage", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const { id } = yield* sessions.create({})
    const m = message(id)
    request(id, m, "zero_req", 1, { outcome: "completed", input: 100, cacheRead: 0 })
    request(id, m, "missing_req", 2, { outcome: "completed", input: 50 })

    const summary = Flight.overview({ projectID: instance.project.id })!
    expect(summary.requests.samples).toBe(2)
    expect(summary.requests.usage.cache).toMatchObject({ input: 100, read: 0, samples: 1 })
    expect(summary.requests.usage.cache.hitRate).toBe(0)
    expect(summary.requests.usage.cache.excluded).toEqual({ invalid: 0, incomplete: 1 })

    const page = Flight.pageGlobal({ projectID: instance.project.id }, {}, "requests", 10)!
    expect(page.items.find((row) => row.id === "zero_req")?.cacheRead).toBe(0)
    expect(page.items.find((row) => row.id === "missing_req")?.cacheRead).toBeUndefined()
  }),
)

it.instance(
  "global request pages follow (time,id), keep detached rows out, and bind cursors to scope and filters",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* InstanceState.context
      const first = yield* sessions.create({})
      const second = yield* sessions.create({
        parentID: first.id,
        workspaceID: WorkspaceID.make("wrk_flight_page"),
      })
      const firstMessage = message(first.id)
      const secondMessage = message(second.id)
      const hidden = message(first.id, { detached: 1 })

      // 三行同一毫秒，靠 id 做次级排序；另有一行 provider 不同、一行 detached、一行别的会话。
      request(
        first.id,
        firstMessage,
        "page_req_c",
        1000,
        { outcome: "completed", input: 100 },
        "page-provider",
        "page-model",
      )
      request(first.id, firstMessage, "page_req_b", 1000, { outcome: "failed" }, "page-provider", "page-model")
      request(
        second.id,
        secondMessage,
        "page_req_a",
        1000,
        { outcome: "completed", input: 10, cacheRead: 10 },
        "page-provider",
        "page-model",
      )
      request(first.id, firstMessage, "page_req_other", 1000, { outcome: "completed" }, "other-provider", "page-model")
      request(first.id, hidden, "page_req_hidden", 1000, { outcome: "completed" }, "page-provider", "page-model")

      const scope = { projectID: instance.project.id }
      const filters = { providerID: "page-provider" }
      const page = Flight.pageGlobal(scope, filters, "requests", 2)!
      expect(page.items.map((row) => row.id)).toEqual(["page_req_c", "page_req_b"])
      expect(page.scanned).toBeGreaterThanOrEqual(4)
      expect(page.truncated).toBe(false)
      expect(page.next).toBeTruthy()

      const next = Flight.pageGlobal(scope, filters, "requests", 2, page.next)!
      expect(next.items.map((row) => row.id)).toEqual(["page_req_a"])
      expect(next.scanned).toBeGreaterThanOrEqual(1)
      expect(next.items[0]).toMatchObject({ sessionID: second.id, sub: true, workspaceID: "wrk_flight_page" })
      expect(next.next).toBeUndefined()
      expect(next.truncated).toBe(false)

      const ids = [...page.items, ...next.items].map((row) => row.id).sort()
      expect(ids).toEqual(["page_req_a", "page_req_b", "page_req_c"])

      // 游标绑定作用域、来源和全部筛选。
      expect(
        Flight.pageGlobal({ projectID: ProjectID.make("other-project-global") }, filters, "requests", 2, page.next),
      ).toBeUndefined()
      expect(
        Flight.pageGlobal(scope, { ...filters, providerID: "other-provider" }, "requests", 2, page.next),
      ).toBeUndefined()
      expect(Flight.pageGlobal(scope, filters, "steps", 2, page.next)).toBeUndefined()
      expect(Flight.pageGlobal(scope, filters, "requests", 2, "not a cursor")).toBeUndefined()

      const bySession = Flight.pageGlobal(scope, { ...filters, sessionID: second.id }, "requests", 10)!
      expect(bySession.items.map((row) => row.id)).toEqual(["page_req_a"])
      const byWorkspace = Flight.pageGlobal(
        scope,
        { ...filters, workspaceID: WorkspaceID.make("wrk_flight_page") },
        "requests",
        10,
      )!
      expect(byWorkspace.items.map((row) => row.id)).toEqual(["page_req_a"])
      expect(
        Flight.pageGlobal(scope, { ...filters, sessionID: first.id }, "requests", 10)?.items.map((row) => row.id),
      ).toEqual(["page_req_c", "page_req_b"])
    }),
)

it.instance("global scans are bounded, report truncation, and let filtered pages continue past the window", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    // 多会话分布：全局窗口要跨会话取行，而不是依赖单会话前缀索引。
    const workers = [{ id: (yield* sessions.create({})).id }]
    for (let index = 1; index < 4; index++) {
      const created = yield* sessions.create({})
      workers.push({ id: created.id })
    }
    const messages = new Map(workers.map((worker) => [worker.id, message(worker.id)]))
    const m = messages.get(workers[0]!.id)!
    const scan = Flight.GLOBAL_SCAN_LIMIT
    const pageScan = Flight.PAGE_SCAN_LIMIT

    requests(
      Array.from({ length: scan + 5 }, (_, index) => {
        const worker = workers[index % workers.length]!
        return {
          id: `trunc_${String(index).padStart(4, "0")}`,
          session_id: worker.id,
          message_id: messages.get(worker.id)!,
          time_created: 5000,
          provider_id: "trunc-provider",
          model_id: "trunc-model",
          data: { outcome: "completed" as const, input: 10, cacheRead: 5 },
        }
      }),
    )
    steps(
      Array.from({ length: scan + 5 }, (_, index) => {
        const worker = workers[index % workers.length]!
        return {
          session: worker.id,
          message: messages.get(worker.id)!,
          time: 5000,
          data: { type: "step-finish", tokens: { context: 10, output: 1, cache: { read: 5 } } },
        }
      }),
    )
    const cap = 55
    requests([
      ...Array.from({ length: cap }, (_, index) => ({
        id: `cap_${String(index).padStart(2, "0")}`,
        session_id: workers[0]!.id,
        message_id: m,
        time_created: 7000 + index,
        provider_id: `cap-provider-${index}`,
        model_id: "cap-model",
        data: { outcome: "completed" as const },
      })),
      {
        id: "old_row",
        session_id: workers[0]!.id,
        message_id: m,
        time_created: 1000,
        provider_id: "old-provider",
        model_id: "old-model",
        data: { outcome: "completed" as const },
      },
    ])

    const all = Flight.overview({ projectID: instance.project.id })!
    expect(all.steps.samples).toBe(scan)
    expect(all.requests.samples).toBe(scan)
    expect(all.steps.sessions).toEqual({ main: 4, sub: 0 })
    expect(all.requests.sessions).toEqual({ main: 4, sub: 0 })
    expect(all.truncated).toBe(true)
    expect(all.coverage.steps).toMatchObject({ scanned: scan, truncated: true })
    expect(all.coverage.requests).toMatchObject({ scanned: scan, truncated: true })
    expect(all.breakdownsTruncated).toBe(true)
    expect(all.models).toHaveLength(Flight.MAX_GROUPS)
    expect(all.daily).toHaveLength(1)
    expect(all.limits).toEqual({
      scan,
      pageScan,
      groups: Flight.MAX_GROUPS,
      trendDays: Flight.MAX_TREND_DAYS,
    })
    expect(typeof all.next).toBe("string")

    // summary 续查：第二窗口只包含第一窗口之外的行，不再有 next。
    const summaryMore = Flight.overview({ projectID: instance.project.id }, {}, all.next)!
    expect(summaryMore.steps.samples).toBe(5)
    expect(summaryMore.requests.samples).toBe(61)
    expect(summaryMore.truncated).toBe(false)
    expect(summaryMore.next).toBeUndefined()

    // 筛选命中在 summary 窗口之外：第一窗口空但带 next，续扫才能看到 old-provider。
    const filtered = Flight.overview({ projectID: instance.project.id }, { providerID: "old-provider" })!
    expect(filtered.steps.samples).toBe(0)
    expect(filtered.requests.samples).toBe(0)
    expect(filtered.truncated).toBe(true)
    expect(typeof filtered.next).toBe("string")
    const filteredMore = Flight.overview(
      { projectID: instance.project.id },
      { providerID: "old-provider" },
      filtered.next,
    )!
    expect(filteredMore.steps.samples).toBe(0)
    expect(filteredMore.requests.samples).toBe(1)
    expect(filteredMore.next).toBeUndefined()
    expect(filteredMore.truncated).toBe(false)

    // 最新窗口里没有 old-provider：空页 + next + truncated 都必须保留，不能当成“没有历史”。
    const stalled = Flight.pageGlobal(
      { projectID: instance.project.id },
      { providerID: "old-provider" },
      "requests",
      20,
    )!
    expect(stalled.items).toEqual([])
    expect(stalled.scanned).toBe(pageScan)
    expect(stalled.truncated).toBe(true)
    expect(stalled.next).toBeTruthy()

    // 老记录在扫描窗口更深处：逐页跟随 next（每页只检查 pageScan 行），最终必须找到它。
    let page = stalled
    let pages = 0
    while (page.items.length === 0 && page.next !== undefined) {
      page = Flight.pageGlobal(
        { projectID: instance.project.id },
        { providerID: "old-provider" },
        "requests",
        20,
        page.next,
      )!
      pages += 1
      expect(page.scanned).toBeLessThanOrEqual(pageScan)
      if (pages > 10) throw new Error("filter match was not reachable through next")
    }
    expect(pages).toBeGreaterThan(0)
    expect(page.items.map((row) => row.id)).toEqual(["old_row"])
    expect(page.truncated).toBe(false)
    expect(page.next).toBeUndefined()
  }),
)

it.instance("scoped window queries use the scope indexes without a temp sort", () =>
  Effect.gen(function* () {
    const plan = (statement: ReturnType<typeof sql>) =>
      (
        Database.use((db) => db.all(sql`EXPLAIN QUERY PLAN ${statement}`)) as {
          detail: string
        }[]
      )
        .map((row) => row.detail)
        .join("\n")

    const steps = plan(sql`
      with window_rows as materialized (
        select sc.id, sc.session_id, sc.message_id, sc.time_created from flight_scope sc
        where sc.project_id = 'p' and sc.kind = 'step' and sc.visible = 1
        order by sc.time_created desc, sc.id desc
        limit ${Flight.GLOBAL_SCAN_LIMIT}
      )
      select w.id, s.project_id, m.id
      from window_rows w
      join part p on p.id = w.id
      join session s on s.id = w.session_id
      join message m on m.id = w.message_id
    `)
    expect(steps).toContain("flight_scope_project_time_idx")
    expect(steps).not.toContain("TEMP B-TREE")

    const requests = plan(sql`
      with window_rows as materialized (
        select sc.id, sc.session_id, sc.message_id, sc.time_created from flight_scope sc
        where sc.project_id = 'p' and sc.kind = 'request' and sc.visible = 1
        order by sc.time_created desc, sc.id desc
        limit ${Flight.PAGE_SCAN_LIMIT}
      )
      select w.id, s.project_id, m.id
      from window_rows w
      join flight_request r on r.id = w.id
      join session s on s.id = w.session_id
      join message m on m.id = w.message_id
    `)
    expect(requests).toContain("flight_scope_project_time_idx")
    expect(requests).not.toContain("TEMP B-TREE")

    const workspace = plan(sql`
      with window_rows as materialized (
        select sc.id, sc.session_id, sc.message_id, sc.time_created from flight_scope sc
        where sc.project_id = 'p' and sc.workspace_id = 'w' and sc.kind = 'step' and sc.visible = 1
        order by sc.time_created desc, sc.id desc
        limit ${Flight.PAGE_SCAN_LIMIT}
      )
      select w.id, s.project_id, m.id
      from window_rows w
      join part p on p.id = w.id
      join session s on s.id = w.session_id
      join message m on m.id = w.message_id
    `)
    expect(workspace).toContain("flight_scope_workspace_time_idx")
    expect(workspace).not.toContain("TEMP B-TREE")
  }),
)

it.instance("step rows expose the recorded requestID without joining a request row", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const { id } = yield* sessions.create({})
    const m = message(id)
    const linked = part(id, m, 10, {
      type: "step-finish",
      cost: 0.5,
      currency: "USD",
      // 请求行故意不存在：关联号是 step-finish 自己的字段，不能被 JOIN 或请求费用补出来。
      requestID: "request-linked-but-expired",
      tokens: { context: 10, output: 1, cache: { read: 5 } },
    })
    const legacy = part(id, m, 20, {
      type: "step-finish",
      cost: 0.1,
      tokens: { context: 1, output: 1 },
    })

    const scoped = Flight.page(id, { projectID: instance.project.id }, "steps", 10)!
    expect(scoped.items.find((row) => row.id === linked)?.requestID).toBe("request-linked-but-expired")
    expect(scoped.items.find((row) => row.id === linked)?.cost).toBe(0.5)
    expect(scoped.items.find((row) => row.id === legacy)?.requestID).toBeUndefined()

    const global = Flight.pageGlobal({ projectID: instance.project.id }, { from: 0, to: 100 }, "steps", 50)!
    expect(global.items.find((row) => row.id === linked)?.requestID).toBe("request-linked-but-expired")
    expect(global.items.find((row) => row.id === linked)?.cost).toBe(0.5)
    expect(global.items.find((row) => row.id === legacy)?.requestID).toBeUndefined()
  }),
)

// 261126 Red FR-04 越权回归：全局窗口不能先读其他项目再过滤。cursor/coverage/scanned 只能
// 反映当前实例作用域内可见的行；其他项目更活跃时不能改变页、计数或游标。
it.instance("global scope excludes foreign projects from counts, cursors and coverage", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const target = yield* sessions.create({})
    const targetMessage = message(target.id)
    requests([
      {
        id: "scope_target_req_a",
        session_id: target.id,
        message_id: targetMessage,
        time_created: 10,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      },
      {
        id: "scope_target_req_b",
        session_id: target.id,
        message_id: targetMessage,
        time_created: 11,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      },
    ])
    part(target.id, targetMessage, 10, { type: "step-finish", tokens: { context: 1, output: 1 } })
    part(target.id, targetMessage, 11, { type: "step-finish", tokens: { context: 1, output: 1 } })
    foreignFlightRows(5_100, 1_000)

    const summary = Flight.overview({ projectID: instance.project.id })!
    expect(summary.steps.samples).toBe(2)
    expect(summary.requests.samples).toBe(2)
    expect(summary.coverage.steps).toEqual({ from: 10, to: 11, scanned: 2, truncated: false })
    expect(summary.coverage.requests).toEqual({ from: 10, to: 11, scanned: 2, truncated: false })
    expect(summary.truncated).toBe(false)
    expect(summary.next).toBeUndefined()

    const page = Flight.pageGlobal({ projectID: instance.project.id }, {}, "requests", 10)!
    expect(page.items.map((row) => row.id)).toEqual(["scope_target_req_b", "scope_target_req_a"])
    expect(page.scanned).toBe(2)
    expect(page.truncated).toBe(false)
    expect(page.next).toBeUndefined()

    // 游标边界只取作用域内的行：limit=1 翻页后第二条仍是本项目的行，翻完即结束。
    const cursorPage = Flight.pageGlobal({ projectID: instance.project.id }, {}, "requests", 1)!
    expect(cursorPage.items.map((row) => row.id)).toEqual(["scope_target_req_b"])
    const cursorRest = Flight.pageGlobal({ projectID: instance.project.id }, {}, "requests", 1, cursorPage.next)!
    expect(cursorRest.items.map((row) => row.id)).toEqual(["scope_target_req_a"])
    expect(cursorRest.next).toBeUndefined()

    // 目标项目在该时间段没有行；其他项目有 5,100 行也不能变成 scanned=5000/next。
    const empty = Flight.overview({ projectID: instance.project.id }, { from: 1_000, to: 6_100 })!
    expect(empty.steps.samples).toBe(0)
    expect(empty.requests.samples).toBe(0)
    expect(empty.coverage.steps).toEqual({ scanned: 0, truncated: false })
    expect(empty.coverage.requests).toEqual({ scanned: 0, truncated: false })
    expect(empty.truncated).toBe(false)
    expect(empty.next).toBeUndefined()

    const emptyPage = Flight.pageGlobal({ projectID: instance.project.id }, { from: 1_000, to: 6_100 }, "requests", 10)!
    expect(emptyPage.items).toEqual([])
    expect(emptyPage.scanned).toBe(0)
    expect(emptyPage.truncated).toBe(false)
    expect(emptyPage.next).toBeUndefined()
  }),
)

it.instance("workspace and detached boundaries stay out of counts and cursors", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const workspaceA = WorkspaceID.make("wrk_scope_a")
    const workspaceB = WorkspaceID.make("wrk_scope_b")
    const a = yield* sessions.create({ workspaceID: workspaceA })
    const aMessage = message(a.id)
    requests([
      {
        id: "scope_ws_a_req_a",
        session_id: a.id,
        message_id: aMessage,
        time_created: 10,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      },
      {
        id: "scope_ws_a_req_b",
        session_id: a.id,
        message_id: aMessage,
        time_created: 11,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      },
    ])
    part(a.id, aMessage, 10, { type: "step-finish", tokens: { context: 1, output: 1 } })
    part(a.id, aMessage, 11, { type: "step-finish", tokens: { context: 1, output: 1 } })

    const detachedMessage = message(a.id, { detached: 1 })
    requests([
      {
        id: "scope_ws_detached_req",
        session_id: a.id,
        message_id: detachedMessage,
        time_created: 20,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      },
    ])
    part(a.id, detachedMessage, 20, { type: "step-finish", tokens: { context: 1, output: 1 } })

    const b = yield* sessions.create({ workspaceID: workspaceB })
    const bMessage = message(b.id)
    requests(
      Array.from({ length: 1_100 }, (_, index) => ({
        id: `scope_ws_b_req_${String(index).padStart(4, "0")}`,
        session_id: b.id,
        message_id: bMessage,
        time_created: 1_000 + index,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      })),
    )
    steps(
      Array.from({ length: 1_100 }, (_, index) => ({
        session: b.id,
        message: bMessage,
        time: 1_000 + index,
        data: { type: "step-finish", tokens: { context: 1, output: 1 } },
      })),
    )

    const workspaceScope = { projectID: instance.project.id, workspaceID: workspaceA }
    const workspaceSummary = Flight.overview(workspaceScope)!
    expect(workspaceSummary.steps.samples).toBe(2)
    expect(workspaceSummary.requests.samples).toBe(2)
    expect(workspaceSummary.coverage.steps).toEqual({ from: 10, to: 11, scanned: 2, truncated: false })
    expect(workspaceSummary.coverage.requests).toEqual({ from: 10, to: 11, scanned: 2, truncated: false })
    expect(workspaceSummary.next).toBeUndefined()

    const workspacePage = Flight.pageGlobal(workspaceScope, {}, "requests", 10)!
    expect(workspacePage.items.map((row) => row.id)).toEqual(["scope_ws_a_req_b", "scope_ws_a_req_a"])
    expect(workspacePage.scanned).toBe(2)
    expect(workspacePage.truncated).toBe(false)
    expect(workspacePage.next).toBeUndefined()

    // 项目级作用域看到 A/B 两个工作区，但 detached 行仍不计数；旧实现会把 detached 行算进 scanned。
    const projectSummary = Flight.overview({ projectID: instance.project.id })!
    expect(projectSummary.steps.samples).toBe(1_102)
    expect(projectSummary.requests.samples).toBe(1_102)
    expect(projectSummary.coverage.steps.scanned).toBe(1_102)
    expect(projectSummary.coverage.requests.scanned).toBe(1_102)
    expect(projectSummary.truncated).toBe(false)
    expect(projectSummary.next).toBeUndefined()
  }),
)

it.instance("per-session page does not return rows from another project", () =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const foreign = foreignFlightRows(1, 7_000)
    const scope = { projectID: instance.project.id }
    expect(Flight.page(foreign.sessionID, scope, "requests")).toEqual({ items: [] })
    expect(Flight.page(foreign.sessionID, scope, "steps")).toEqual({ items: [] })
  }),
)

it.instance("detached toggles remove rows from the scope window", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const { id } = yield* sessions.create({})
    const m = message(id)
    requests([
      {
        id: "toggle_req",
        session_id: id,
        message_id: m,
        time_created: 10,
        provider_id: "target",
        model_id: "target",
        data: { outcome: "completed" as const },
      },
    ])
    part(id, m, 10, { type: "step-finish", tokens: { context: 1, output: 1 } })

    const before = Flight.overview({ projectID: instance.project.id })!
    expect(before.requests.samples).toBe(1)
    expect(before.steps.samples).toBe(1)
    expect(before.coverage.requests.scanned).toBe(1)
    expect(before.coverage.steps.scanned).toBe(1)

    // branch.ts 的弃岛路径就是这样更新 message.data；scope 的 visible 必须随之翻转。
    Database.use((db) => db.run(sql`update message set data = json_set(data, '$.detached', 1) where id = ${m}`))
    const after = Flight.overview({ projectID: instance.project.id })!
    expect(after.requests.samples).toBe(0)
    expect(after.steps.samples).toBe(0)
    expect(after.coverage.requests.scanned).toBe(0)
    expect(after.coverage.steps.scanned).toBe(0)
    expect(after.next).toBeUndefined()
  }),
)

// 261126 Red FR-04 part 的 data 可能在非 step-finish 与 step-finish 之间翻转（历史迁移、修复脚本、
// 未来的 part 重写）。触发器只监听 session_id/message_id/time_created 时，投影会永久漏行或保留
// 已不是 step-finish 的行；这里把两个方向与「保持 step-finish 的 data 更新」都钉死。
it.instance("part data type transitions keep the scope projection exact", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const { id } = yield* sessions.create({})
    const m = message(id)
    const scope = { projectID: instance.project.id }
    const converted = part(id, m, 10, { type: "text", text: "not a step yet" })
    const removed = part(id, m, 20, { type: "step-finish", tokens: { context: 1, output: 1 } })

    expect(Flight.overview(scope)!.steps.samples).toBe(1)
    expect(Flight.pageGlobal(scope, {}, "steps", 10)!.items.map((row) => row.id)).toEqual([removed])

    Database.use((db) =>
      db.run(sql`update part set data = json_set(data, '$.type', 'step-finish') where id = ${converted}`),
    )
    expect(Flight.pageGlobal(scope, {}, "steps", 10)!.items.map((row) => row.id)).toEqual([removed, converted])
    expect(Flight.overview(scope)!.coverage.steps.scanned).toBe(2)

    // 仍然是 step-finish，只补结算字段：投影必须保持一行，不能掉行也不能重复。
    Database.use((db) =>
      db.run(sql`update part set data = json_set(data, '$.cost', 0.5, '$.currency', 'USD') where id = ${removed}`),
    )
    const settled = Flight.pageGlobal(scope, {}, "steps", 10)!
    expect(settled.items.map((row) => row.id)).toEqual([removed, converted])
    expect(settled.items.find((row) => row.id === removed)?.cost).toBe(0.5)
    expect(Flight.overview(scope)!.coverage.steps.scanned).toBe(2)

    Database.use((db) => db.run(sql`update part set data = json_set(data, '$.type', 'tool') where id = ${removed}`))
    expect(Flight.pageGlobal(scope, {}, "steps", 10)!.items.map((row) => row.id)).toEqual([converted])
    expect(Flight.overview(scope)!.steps.samples).toBe(1)
    expect(Flight.overview(scope)!.coverage.steps.scanned).toBe(1)
  }),
)

it.instance("session project and workspace moves follow the scope projection", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const workspace = WorkspaceID.make("wrk_scope_move_a")
    const movedWorkspace = WorkspaceID.make("wrk_scope_move_b")
    const { id } = yield* sessions.create({ workspaceID: workspace })
    const m = message(id)
    part(id, m, 10, { type: "step-finish", tokens: { context: 2, output: 1 } })
    request(id, m, "move_req", 11, { outcome: "completed", input: 2 })

    const projectScope = { projectID: instance.project.id }
    expect(Flight.overview(projectScope)!.steps.samples).toBe(1)
    expect(Flight.overview({ ...projectScope, workspaceID: workspace })!.steps.samples).toBe(1)

    // 同一项目内换工作区：项目级仍可见，旧工作区不可见，新工作区可见。
    Database.use((db) => db.run(sql`update session set workspace_id = ${movedWorkspace} where id = ${id}`))
    expect(Flight.overview(projectScope)!.steps.samples).toBe(1)
    expect(Flight.overview({ ...projectScope, workspaceID: workspace })!.steps.samples).toBe(0)
    expect(Flight.overview({ ...projectScope, workspaceID: movedWorkspace })!.steps.samples).toBe(1)
    expect(Flight.pageGlobal({ ...projectScope, workspaceID: workspace }, {}, "requests", 10)!.items).toEqual([])

    // 整个会话迁到别的项目：原项目看不到，新项目（含工作区作用域）能看到。
    const movedProject = ProjectID.make("project-scope-moved")
    Database.use((db) =>
      db.run(sql`insert into project (id, worktree, sandboxes, time_created, time_updated)
        values (${movedProject}, '/moved', '[]', 1, 1)`),
    )
    Database.use((db) => db.run(sql`update session set project_id = ${movedProject} where id = ${id}`))
    expect(Flight.overview(projectScope)!.steps.samples).toBe(0)
    expect(Flight.overview(projectScope)!.requests.samples).toBe(0)
    expect(Flight.pageGlobal(projectScope, {}, "steps", 10)!.items).toEqual([])
    expect(Flight.overview({ projectID: movedProject })!.steps.samples).toBe(1)
    expect(Flight.overview({ projectID: movedProject, workspaceID: movedWorkspace })!.requests.samples).toBe(1)
  }),
)

it.instance("scope rows follow part, request, message and session deletes", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    // 同一测试进程里不同用例可能共用库文件，只数本项目作用域的行。
    const scopeRows = () =>
      Database.use(
        (db) =>
          db.all<{ count: number }>(
            sql`select count(*) as count from flight_scope where project_id = ${instance.project.id}`,
          )[0]!.count,
      )
    const seed = (session: SessionID, suffix: string) => {
      const m = message(session)
      const p = part(session, m, 10, { type: "step-finish", tokens: { context: 1, output: 1 } })
      request(session, m, `cascade_req_${suffix}`, 11, { outcome: "completed" })
      return { m, p }
    }

    const kept = seed((yield* sessions.create({})).id, "keep")
    const dropped = seed((yield* sessions.create({})).id, "drop")
    expect(scopeRows()).toBe(4)

    Database.use((db) => db.run(sql`delete from part where id = ${dropped.p}`))
    expect(scopeRows()).toBe(3)
    Database.use((db) => db.run(sql`delete from flight_request where id = ${"cascade_req_drop"}`))
    expect(scopeRows()).toBe(2)

    // 删消息时 part / flight_request 由外键级联，它们的删除触发器负责清投影。
    Database.use((db) => db.run(sql`delete from message where id = ${kept.m}`))
    expect(scopeRows()).toBe(0)

    const thirdSession = yield* sessions.create({})
    seed(thirdSession.id, "third")
    expect(scopeRows()).toBe(2)
    Database.use((db) => db.run(sql`delete from session where id = ${thirdSession.id}`))
    expect(scopeRows()).toBe(0)
  }),
)

// 261126 Red FR-04 双重验证：窗口从 flight_scope 读作用域，结果仍要 JOIN session 复核真实归属。
// 人为制造「投影与真实归属不一致」的旧库/外部写入，两个方向都不能把行暴露给别的项目。
it.instance("global queries re-check the session join when the scope projection is stale", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instance = yield* InstanceState.context
    const { id } = yield* sessions.create({})
    const m = message(id)
    const step = part(id, m, 10, { type: "step-finish", tokens: { context: 1, output: 1 } })
    request(id, m, "stale_req", 11, { outcome: "completed" })

    const foreign = ProjectID.make("project-scope-stale")
    Database.use((db) =>
      db.run(sql`update flight_scope set project_id = ${foreign}
        where (kind = 'step' and id = ${step}) or (kind = 'request' and id = ${"stale_req"})`),
    )

    // 本项目的窗口只认投影，投影被移走后本项目的数字必须归零（不能残留计数）。
    const own = Flight.overview({ projectID: instance.project.id })!
    expect(own.steps.samples).toBe(0)
    expect(own.requests.samples).toBe(0)
    expect(own.coverage.steps.scanned).toBe(0)
    expect(own.coverage.requests.scanned).toBe(0)

    // 伪造项目能命中投影，但 JOIN session 得到的真实 project_id 不符，仍不得返回行。
    const forged = Flight.overview({ projectID: foreign })!
    expect(forged.steps.samples).toBe(0)
    expect(forged.requests.samples).toBe(0)
    expect(forged.models).toEqual([])
    expect(forged.workspaces).toEqual([])

    Database.use((db) =>
      db.run(sql`update flight_scope set project_id = ${instance.project.id}
        where (kind = 'step' and id = ${step}) or (kind = 'request' and id = ${"stale_req"})`),
    )
    expect(Flight.overview({ projectID: instance.project.id })!.steps.samples).toBe(1)
    expect(Flight.overview({ projectID: instance.project.id })!.requests.samples).toBe(1)
  }),
)

// 261126 Red FR-04 旧库升级：scope 迁移要回填已有的 step-finish 与 flight_request；非 step-finish
// part 不进入索引，detached 消息保留 visible=0。这里按文件夹顺序手工应用到 scope 迁移之前，
// 模拟真实升级，而不是在已经带触发器的库上再跑一遍。
it.instance("scope migration backfills an existing database before triggers exist", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const database = new BunDatabase(join(directory, "flight-scope-upgrade.db"))
    try {
      database.run("PRAGMA foreign_keys = ON")
      const root = join(import.meta.dir, "../../migration")
      const scopeMigration = "20261126123231_flight_scope_index"
      for (const name of readdirSync(root)
        .filter((name) => /^\d{14}_/.test(name) && name < scopeMigration)
        .sort()) {
        database.exec(readFileSync(join(root, name, "migration.sql"), "utf8"))
      }
      database.run(
        "insert into project (id, worktree, sandboxes, time_created, time_updated) values ('upgrade-project', '/upgrade', '[]', 1, 1)",
      )
      database.run(
        "insert into session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) values ('ses_upgrade', 'upgrade-project', 'wrk_upgrade', 'ses_upgrade', '/upgrade', 'Upgrade', '0', 1, 1)",
      )
      database.run(
        `insert into message (id, session_id, time_created, time_updated, data) values ('msg_upgrade', 'ses_upgrade', 1, 1, '{"role":"assistant","providerID":"p","modelID":"m"}')`,
      )
      database.run(
        `insert into message (id, session_id, time_created, time_updated, data) values ('msg_detached', 'ses_upgrade', 1, 1, '{"role":"assistant","detached":1}')`,
      )
      database.run(
        `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_step', 'msg_upgrade', 'ses_upgrade', 10, 10, '{"type":"step-finish","tokens":{"context":1,"output":1}}')`,
      )
      database.run(
        `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_text', 'msg_upgrade', 'ses_upgrade', 11, 11, '{"type":"text","text":"private"}')`,
      )
      database.run(
        `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_detached', 'msg_detached', 'ses_upgrade', 12, 12, '{"type":"step-finish","tokens":{"context":1,"output":1}}')`,
      )
      database.run(
        `insert into flight_request (id, session_id, message_id, time_created, provider_id, model_id, data) values ('req_upgrade', 'ses_upgrade', 'msg_upgrade', 13, 'p', 'm', '{"outcome":"completed"}')`,
      )

      database.exec(readFileSync(join(root, scopeMigration, "migration.sql"), "utf8"))

      expect(
        database.query("select kind, id, project_id, workspace_id, visible from flight_scope order by kind, id").all(),
      ).toEqual([
        { kind: "request", id: "req_upgrade", project_id: "upgrade-project", workspace_id: "wrk_upgrade", visible: 1 },
        { kind: "step", id: "prt_detached", project_id: "upgrade-project", workspace_id: "wrk_upgrade", visible: 0 },
        { kind: "step", id: "prt_step", project_id: "upgrade-project", workspace_id: "wrk_upgrade", visible: 1 },
      ])
    } finally {
      database.close()
    }
  }),
)
