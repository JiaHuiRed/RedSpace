/** @jsxImportSource @opentui/solid */
// 261113 Red 重连恢复 / 历史翻页边界 / 会话刷新失败保留 —— 三条都走 SyncProvider 的真实
// 编排，只在 context 边界喂假值（同 transcript.tsx 260828 的理由：provider 链带磁盘与
// 渲染副作用，但被测的判定就在 Sync 自己的代码里，绕过外层不影响结论）。
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { projectContext as ProjectContext } from "../../../src/cli/cmd/tui/context/project"
import { argsContext } from "../../../src/cli/cmd/tui/context/args"
import { exitContext } from "../../../src/cli/cmd/tui/context/exit"
import { context as KVContext } from "../../../src/cli/cmd/tui/context/kv"
import { sdkContext } from "../../../src/cli/cmd/tui/context/sdk"

type Sync = ReturnType<typeof useSync>

const DIRECTORY = "/A"

type EventHandler = (event: { payload: unknown; directory: string; project: string; workspace?: string }) => void

function fixture(client: Record<string, unknown>) {
  const handlers: EventHandler[] = []
  const sdk = {
    directory: DIRECTORY,
    url: "http://redcode.internal",
    signal: new AbortController().signal,
    client,
    event: { on: (_type: string, handler: EventHandler) => handlers.push(handler) },
  }
  const project = {
    project: () => "prj_1",
    data: { instance: { path: { worktree: DIRECTORY, directory: DIRECTORY } } },
    instance: { path: () => ({ worktree: DIRECTORY, directory: DIRECTORY }) },
    workspace: { current: () => DIRECTORY, list: () => [] },
  }
  const kv = { get: (_key: string, fallback?: unknown) => fallback }

  let sync!: Sync
  function Capture() {
    sync = useSync()
    return <box />
  }

  const mount = async () => {
    const app = await testRender(() => (
      <KVContext.Provider value={kv as never}>
        <sdkContext.Provider value={sdk as never}>
          <ProjectContext.Provider value={project as never}>
            <argsContext.Provider value={{} as never}>
              <exitContext.Provider value={((async () => {}) as never)}>
                <SyncProvider disabled>
                  <Capture />
                </SyncProvider>
              </exitContext.Provider>
            </argsContext.Provider>
          </ProjectContext.Provider>
        </sdkContext.Provider>
      </KVContext.Provider>
    ))
    await Promise.resolve()
    return { app, emit, sync: () => sync }
  }

  const emit = (payload: { type: string; properties?: unknown }) => {
    for (const handler of handlers) {
      handler({ payload, directory: DIRECTORY, project: "prj_1" })
    }
  }

  return { mount, emit }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("断线重连会重新拉取断线期间产生的权限请求", async () => {
  const permission = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [], always: [] }
  let permissionListCalls = 0
  const f = fixture({
    permission: {
      list: async () => {
        permissionListCalls++
        return { data: [permission] }
      },
    },
    question: { list: async () => ({ data: [] }) },
    session: { status: async () => ({ data: {} }) },
  })
  const { app, sync } = await f.mount()

  // 首连由 bootstrap 全量加载，重连才补拉；SSE 没有事件重放，权限请求只能在重连时拉回来。
  f.emit({ type: "server.connected", properties: {} })
  f.emit({ type: "server.connected", properties: {} })
  await tick()

  expect(permissionListCalls).toBe(1)
  expect(sync().data.permission["ses_1"]?.map((item) => item.id)).toEqual(["per_1"])
  app.renderer.destroy()
})

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    info: { id, sessionID: "ses_1", role: "assistant", time: { created: Number(id.slice(4)) || 1 }, ...extra },
    parts: [],
  }
}

function seed(sync: Sync) {
  // store.message 存的是 Message.Info（parts 另存 store.part），别塞 WithParts。
  sync.set("message", "ses_1", [message("msg_9").info as never])
}

async function earlierPage(page: ReturnType<typeof message>[]) {
  let requests = 0
  const f = fixture({
    session: {
      messages: async () => {
        requests++
        return { data: page }
      },
    },
  })
  const { app, sync } = await f.mount()
  seed(sync())
  const more = await sync().session.loadEarlier("ses_1")
  app.renderer.destroy()
  return { more, ids: sync().data.message["ses_1"]?.map((item) => item.id), requests }
}

test("分页遇到完整摘要就停，不把被压缩的原文放回界面", async () => {
  const { more, ids } = await earlierPage([
    message("msg_1"),
    message("msg_2", { summary: true, finish: "stop" }),
  ])
  expect(more).toBe(false)
  expect(ids).toEqual(["msg_9"])
})

test("finish=length 的截断摘要不是边界，继续向前翻页", async () => {
  const { more, ids } = await earlierPage([
    message("msg_1"),
    message("msg_2", { summary: true, finish: "length" }),
  ])
  expect(more).toBe(true)
  expect(ids).toEqual(["msg_1", "msg_2", "msg_9"])
})

test("finish=unknown 的重复停止摘要不是边界，继续向前翻页", async () => {
  const { more, ids } = await earlierPage([
    message("msg_1"),
    message("msg_2", { summary: true, finish: "unknown" }),
  ])
  expect(more).toBe(true)
  expect(ids).toEqual(["msg_1", "msg_2", "msg_9"])
})

test("刷新会话列表失败时保留旧列表，不按空数组覆盖", async () => {
  let calls = 0
  const f = fixture({
    session: {
      list: async () => {
        calls++
        if (calls === 1) return { data: [{ id: "ses_1", time: { created: 1, updated: 1 } }] }
        throw new Error("500")
      },
    },
  })
  const { app, sync } = await f.mount()

  await sync().session.refresh()
  expect(sync().data.session.map((item) => item.id)).toEqual(["ses_1"])

  await sync().session.refresh()
  expect(sync().data.session.map((item) => item.id)).toEqual(["ses_1"])
  app.renderer.destroy()
})

function row(sessionID: string, id: string, text: string) {
  return {
    info: message(id, { sessionID }).info,
    parts: [{ id: `prt_${id}`, type: "text" as const, messageID: id, sessionID, text }],
  }
}

type Page = ReturnType<typeof row>[]
const info = (id: string) => ({
  id,
  slug: id,
  title: id,
  projectID: "prj_1",
  directory: DIRECTORY,
  version: "1",
  time: { created: 1, updated: 1 },
})

function mountHistory(read: (id: string) => Page | Promise<Page>) {
  return fixture({
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ data: info(sessionID) }),
      messages: async ({ sessionID }: { sessionID: string }) => ({ data: await read(sessionID) }),
      todo: async () => ({ data: [] }),
      diff: async () => ({ data: [] }),
      goal: async () => ({}),
      messageVersions: async () => ({ data: [] }),
    },
  }).mount()
}

test("移除消息只释放它的正文；删除会话也清已加载标记和窗口之外的分片", async () => {
  const rows = [row("a", "msg_1", "x".repeat(128 * 1024)), row("a", "msg_2", "keep")]
  const other = row("b", "msg_3", "other")
  const { app, emit, sync } = await mountHistory((id) => (id === "a" ? rows : [other]))
  try {
    await sync().session.sync("a")
    await sync().session.sync("b")
    emit({ type: "message.removed", properties: { sessionID: "a", messageID: "msg_1" } })
    expect(sync().data.message.a?.map((m) => m.id)).toEqual(["msg_2"])
    expect(sync().data.part.msg_1).toBeUndefined()
    expect(sync().data.part.msg_2).toEqual(rows[1]!.parts)

    const orphan = row("a", "msg_4", "part arrived first").parts[0]!
    emit({ type: "message.part.updated", properties: { part: orphan } })
    expect(sync().data.part.msg_4).toEqual([orphan])
    emit({ type: "session.deleted", properties: { info: info("a") } })
    expect(sync().session.get("a")).toBeUndefined()
    expect(sync().data.message.a).toBeUndefined()
    expect(sync().data.session_diff.a).toBeUndefined()
    expect(sync().data.message_versions.a).toBeUndefined()
    expect(Object.keys(sync().data.part)).toEqual(["msg_3"])
    expect(sync().data.part.msg_3).toEqual(other.parts)
    emit({ type: "message.removed", properties: { sessionID: "a", messageID: "msg_1" } })
    expect(sync().data.message.a).toBeUndefined()
    await sync().session.sync("a")
    expect(sync().data.part.msg_1).toEqual(rows[0]!.parts)
  } finally {
    app.renderer.destroy()
  }
})

test("权威快照成功才释放旧页独有正文，不动相邻会话", async () => {
  const old = row("a", "msg_1", "old")
  const kept = row("a", "msg_2", "original")
  const updated = row("a", "msg_2", "updated")
  const other = row("b", "msg_3", "other")
  let page: Page | undefined = [old, kept]
  const { app, sync } = await mountHistory((id) => {
    if (id === "b") return [other]
    if (!page) throw new Error("snapshot failed")
    return page
  })
  try {
    await sync().session.sync("a")
    await sync().session.sync("b")
    page = undefined
    await expect(sync().session.reconcile("a")).rejects.toThrow("snapshot failed")
    expect(sync().data.part.msg_1).toEqual(old.parts)
    page = [updated]
    await sync().session.reconcile("a")
    expect(sync().data.message.a?.map((m) => m.id)).toEqual(["msg_2"])
    expect(sync().data.part.msg_1).toBeUndefined()
    expect(sync().data.part.msg_2).toEqual(updated.parts)
    expect(sync().data.part.msg_3).toEqual(other.parts)
    page = []
    await sync().session.reconcile("a")
    expect(sync().data.message.a).toEqual([])
    expect(Object.keys(sync().data.part)).toEqual(["msg_3"])
  } finally {
    app.renderer.destroy()
  }
})

test.each(["reconcile", "loadEarlier"] as const)("删除会话后，在途 %s 不能复活正文", async (method) => {
  const gate = Promise.withResolvers<Page>()
  let reads = 0
  const { app, emit, sync } = await mountHistory(() => (++reads === 2 ? gate.promise : [row("a", "msg_2", "visible")]))
  try {
    await sync().session.sync("a")
    const pending = sync().session[method]("a")
    expect(reads).toBe(2)
    emit({ type: "session.deleted", properties: { info: info("a") } })
    gate.resolve([row("a", "msg_1", "stale")])
    await pending
    expect(sync().session.get("a")).toBeUndefined()
    expect(sync().data.message.a).toBeUndefined()
    expect(sync().data.part.msg_1).toBeUndefined()
    await sync().session.sync("a")
    expect(reads).toBe(3)
  } finally {
    app.renderer.destroy()
  }
})
