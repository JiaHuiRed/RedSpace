import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Message, OpencodeClient, Session, SnapshotFileDiff } from "@redcode-ai/sdk/v2/client"
import { createSessionCacheLedger, dropSessionCaches } from "./global-sync/session-cache"
import { createDirSyncContext } from "./directory-sync"
import { pathKey } from "@/utils/path-key"

const sessionID = "ses_cold"
const directory = "C:\\Work\\directory-sync-cold"

const message = (index: number): Message =>
  ({
    id: `msg_${String(index).padStart(3, "0")}`,
    sessionID,
    role: "user",
    time: { created: index },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

function createHarness(options: { failFirstSnapshot?: boolean; diffData?: SnapshotFileDiff[] } = {}) {
  const session = {
    id: sessionID,
    directory,
    title: "Cold session",
    slug: "cold-session",
    projectID: "project",
    version: "1",
    time: { created: 1, updated: 1 },
  } as Session
  const [store, setStore] = createStore({
    status: "complete" as const,
    path: { directory, worktree: directory, config: "", state: "", home: "" },
    project: "project",
    session: [session],
    sessionTotal: 1,
    session_status: {},
    session_diff: {},
    message_trimmed: {},
    todo: {},
    goal: {},
    permission: {},
    question: {},
    message: {},
    part: {},
    part_text_accum_delta: {},
    limit: 10,
  })
  const ledger = createSessionCacheLedger(pathKey)
  const child = [store, setStore] as const
  const globalSync = {
    child: () => child,
    data: { project: [] },
    todo: { set() {} },
    sessionCache: {
      foreground: (dir: string, id: string) => ledger.foreground(dir, id),
      forget: (dir: string, id: string) => ledger.forget(dir, id),
      hasForeground: (dir: string, id: string) => ledger.hasForeground(dir, id),
      evict: (dir: string, ids: string[]) => {
        const target = pathKey(dir)
        if (target !== pathKey(directory)) return
        setStore(produce((state) => dropSessionCaches(state, ids)))
      },
    },
    queryOptions: { sessionOutline: () => ({ queryKey: ["outline"] }) },
  } as unknown as Parameters<typeof createDirSyncContext>[2]

  const afterCalls: number[] = []
  const messageLimits: number[] = []
  let messageCalls = 0
  let failSnapshot = options.failFirstSnapshot ?? false
  const client = {
    session: {
      changes: async ({ after }: { after: string }) => {
        afterCalls.push(Number(after))
        const cursor = after === "-1" ? 7 : Number(after)
        return { data: { latest: cursor, oldest: 0, cursor, changes: [], hasMore: false, reset: false } }
      },
      get: async () => ({ data: session }),
      messages: async ({ limit }: { limit: number }) => {
        messageCalls++
        messageLimits.push(limit)
        if (failSnapshot) {
          failSnapshot = false
          throw new Error("snapshot failed")
        }
        return {
          data: Array.from({ length: limit }, (_, index) => ({
            info: message(index),
            parts: [],
          })),
          response: { headers: new Headers() },
        }
      },
      message: async () => ({ data: { info: message(0), parts: [] } }),
      diff: async () => ({ data: options.diffData ?? [] }),
      todo: async () => ({ data: [] }),
      goal: async () => ({ data: undefined }),
    },
  } as unknown as OpencodeClient
  const queryClient = new QueryClient()

  let context!: ReturnType<typeof createDirSyncContext>
  const dispose = createRoot((dispose) => {
    context = createDirSyncContext(client, directory, globalSync, queryClient)
    return dispose
  })
  return { context, dispose, store, afterCalls, messageCalls: () => messageCalls, messageLimits }
}

describe("directory sync cold journal initialization", () => {
  test("cold sync and first checkpoint share one head-before-snapshot initialization", async () => {
    const harness = createHarness()
    await harness.context.session.sync(sessionID)
    await harness.context.session.catchup(sessionID, () => true)

    expect(harness.afterCalls).toEqual([-1, 7])
    expect(harness.messageCalls()).toBe(1)
    expect(harness.messageLimits).toEqual([200])
    expect((harness.store.message as Record<string, Message[] | undefined>)[sessionID]).toHaveLength(200)
    harness.dispose()
  })

  test("concurrent cold sync calls join the same snapshot and checkpoint", async () => {
    const harness = createHarness()
    await Promise.all([harness.context.session.sync(sessionID), harness.context.session.sync(sessionID)])
    expect(harness.afterCalls).toEqual([-1])
    expect(harness.messageCalls()).toBe(1)
    harness.dispose()
  })

  test("a failed cold snapshot does not acknowledge and retries from the head", async () => {
    const harness = createHarness({ failFirstSnapshot: true })
    await expect(harness.context.session.sync(sessionID)).rejects.toThrow("snapshot failed")
    await harness.context.session.sync(sessionID)

    expect(harness.afterCalls).toEqual([-1, -1])
    expect(harness.messageCalls()).toBe(2)
    expect((harness.store.message as Record<string, Message[] | undefined>)[sessionID]).toHaveLength(200)
    harness.dispose()
  })

  test("warm catchup does not reload the full snapshot page", async () => {
    const harness = createHarness()
    await harness.context.session.sync(sessionID)
    await harness.context.session.catchup(sessionID, () => true)
    await harness.context.session.catchup(sessionID, () => true)

    expect(harness.messageCalls()).toBe(1)
    expect(harness.afterCalls).toEqual([-1, 7, 7])
    harness.dispose()
  })
})

describe("directory sync session diff", () => {
  test("keeps file rows when the server omits patch (patch:false)", async () => {
    const harness = createHarness({
      // 服务端 patch:false 是解构省略 patch（Snapshot.FileDiff 里 patch optional）
      diffData: [
        { file: "src/a.ts", additions: 4, deletions: 1, status: "modified" },
        { file: "src/b.ts", additions: 2, deletions: 0, status: "added" },
      ],
    })

    await harness.context.session.diff(sessionID)

    expect(harness.store.session_diff).toEqual({
      [sessionID]: [
        { file: "src/a.ts", patch: "", additions: 4, deletions: 1, status: "modified" },
        { file: "src/b.ts", patch: "", additions: 2, deletions: 0, status: "added" },
      ],
    })
    harness.dispose()
  })
})
