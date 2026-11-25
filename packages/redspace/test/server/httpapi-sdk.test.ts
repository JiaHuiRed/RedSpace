import { afterEach, describe, expect } from "bun:test"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Schedule } from "effect"
import type * as Scope from "effect/Scope"
import { HttpRouter } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Flag } from "@redcode-ai/core/flag/flag"
import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import { validateSession } from "../../src/cli/cmd/tui/validate-session"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { markIslandRows, unmarkIslandRows } from "../../src/session/branch"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Config } from "@/config/config"
import { Session as SessionNs } from "@/session/session"
import { errorMessage } from "../../src/util/error"
import { reply, TestLLMServer } from "../lib/llm-server"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  ),
)

const original = {
  REDCODE_SERVER_PASSWORD: Flag.REDCODE_SERVER_PASSWORD,
  REDCODE_SERVER_USERNAME: Flag.REDCODE_SERVER_USERNAME,
}

type ServerPath = "default" | "raw"
type Sdk = ReturnType<typeof createOpencodeClient>
type SdkResult = { response: Response; data?: unknown; error?: unknown }
type Captured = { status: number; data?: unknown; error?: unknown }
type ProjectFixture = { sdk: Sdk; directory: string }
type LlmProjectFixture = ProjectFixture & { llm: TestLLMServer["Service"] }
type TestServices = AppFileSystem.Service | ChildProcessSpawner.ChildProcessSpawner | InstanceStore.Service
type TestScope = Scope.Scope | TestServices

function app(serverPath: ServerPath, input?: { password?: string; username?: string }) {
  Flag.REDCODE_SERVER_PASSWORD = input?.password
  Flag.REDCODE_SERVER_USERNAME = input?.username
  if (serverPath === "default") return Server.Default().app

  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            REDCODE_SERVER_PASSWORD: input?.password,
            REDCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function client(
  serverPath: ServerPath,
  directory?: string,
  input?: { password?: string; username?: string; headers?: Record<string, string> },
) {
  return createOpencodeClient({
    baseUrl: "http://localhost",
    directory,
    headers: input?.headers,
    fetch: serverFetch(serverPath, input),
  })
}

function serverFetch(serverPath: ServerPath, input?: { password?: string; username?: string }) {
  const serverApp = app(serverPath, input)
  return Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) =>
      await serverApp.fetch(request instanceof Request ? request : new Request(request, init)),
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function call<T>(request: () => Promise<T>) {
  return Effect.promise(request)
}

function capture(request: () => Promise<SdkResult>) {
  return call(request).pipe(
    Effect.map((result) => ({
      status: result.response.status,
      data: result.data,
      error: result.error,
    })),
  )
}

function captureThrown(request: () => Promise<unknown>) {
  return call(async () => {
    try {
      await request()
    } catch (error) {
      return error
    }
  })
}

function expectStatus(request: () => Promise<{ response: Response }>, status: number) {
  return call(request).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.response.status).toBe(status))),
    Effect.asVoid,
  )
}

function firstEvent(open: (signal: AbortSignal) => Promise<{ stream: AsyncIterator<unknown> }>) {
  return Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.flatMap((controller) =>
      Effect.acquireRelease(
        call(() => open(controller.signal)),
        (events) => call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((events) =>
          call(() => events.stream.next()).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(new Error("timed out waiting for SDK event")),
            }),
          ),
        ),
        Effect.map((result) => result.value),
      ),
    ),
  )
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function statuses(input: Record<string, Captured>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.status]))
}

function firstPartText(value: unknown) {
  return record(array(record(value).parts)[0]).text
}

function sessionTitles(value: unknown) {
  return array(value)
    .map((item) => record(item).title)
    .filter((title): title is string => typeof title === "string")
    .sort()
}

function resetState() {
  return Effect.promise(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })
}

function httpapi<A, E>(name: string, effect: Effect.Effect<A, E, TestScope>) {
  it.live(name, effect)
}

function httpapiInstance<A, E>(
  name: string,
  options: {
    serverPath: ServerPath
    git?: boolean
    config?: Partial<Config.Info>
    setup?: (dir: string) => Effect.Effect<void, E, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  it.instance(
    name,
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* options.setup?.(instance.directory) ?? Effect.void
      return yield* run({ sdk: client(options.serverPath, instance.directory), directory: instance.directory })
    }),
    { git: options.git ?? true, config: { formatter: false, lsp: false, ...options.config } },
  )
}

function serverPathParity<A, E>(name: string, scenario: (serverPath: ServerPath) => Effect.Effect<A, E, TestScope>) {
  it.live(
    name,
    Effect.gen(function* () {
      const standard = yield* scenario("default")
      yield* resetState()
      const raw = yield* scenario("raw")
      expect(raw).toEqual(standard)
    }),
  )
}

function withProject<A, E, E2 = never>(
  serverPath: ServerPath,
  options: {
    git?: boolean
    /** 见 fixture.tmpdirScoped 的同名选项：不放 .git 标记，用于断言「尚未 init git」的用例。 */
    bare?: boolean
    config?: Partial<Config.Info>
    setup?: (dir: string) => Effect.Effect<void, E2, TestServices>
  },
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({
      git: options.git ?? false,
      bare: options.bare ?? false,
      config: { formatter: false, lsp: false, ...options.config },
    })
    yield* options.setup?.(directory) ?? Effect.void
    return yield* run({ sdk: client(serverPath, directory), directory })
  })
}

function withStandardProject<A, E>(
  serverPath: ServerPath,
  run: (input: ProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return withProject(serverPath, { setup: writeStandardFiles }, run)
}

function withFakeLlm<A, E>(serverPath: ServerPath, run: (input: LlmProjectFixture) => Effect.Effect<A, E, TestScope>) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(serverPath, { config: testProviderConfig(llm.url) }, (input) => run({ ...input, llm }))
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function withFakeLlmProject<A, E>(
  serverPath: ServerPath,
  options: { setup?: (dir: string) => Effect.Effect<void, E, TestServices> },
  run: (input: LlmProjectFixture) => Effect.Effect<A, E, TestScope>,
) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(
      serverPath,
      {
        config: testProviderConfig(llm.url),
        setup: options.setup,
      },
      (input) => run({ ...input, llm }),
    )
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function writeStandardFiles(dir: string) {
  return AppFileSystem.Service.use((fs) =>
    Effect.all([
      fs.writeWithDirs(path.join(dir, "hello.txt"), "hello"),
      fs.writeWithDirs(path.join(dir, "needle.ts"), "export const needle = 'sdk-parity'\n"),
    ]).pipe(Effect.asVoid),
  )
}

function writeProjectSkill(dir: string) {
  return AppFileSystem.Service.use((fs) =>
    fs.writeWithDirs(
      path.join(dir, ".redcode", "skills", "project-rest-skill", "SKILL.md"),
      `---
name: project-rest-skill
description: A project skill visible to REST API prompts.
---

# Project REST Skill
`,
    ),
  )
}

function seedMessage(directory: string, sessionID: string) {
  const id = SessionID.make(sessionID)
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          const message = yield* svc.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            tools: {},
          } satisfies MessageV2.User)
          const part = yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: message.id,
            type: "text",
            text: "seeded message",
          })
          return { message, part }
        }),
      ).pipe(Effect.provide(SessionNs.defaultLayer)),
    ),
  )
}

afterEach(async () => {
  Flag.REDCODE_SERVER_PASSWORD = original.REDCODE_SERVER_PASSWORD
  Flag.REDCODE_SERVER_USERNAME = original.REDCODE_SERVER_USERNAME
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi SDK", () => {
  httpapi(
    "uses the generated SDK for global and control routes",
    Effect.gen(function* () {
      const sdk = client("raw")
      const health = yield* call(() => sdk.global.health())
      const log = yield* call(() => sdk.app.log({ service: "httpapi-sdk-test", level: "info", message: "hello" }))

      expect(health.response.status).toBe(200)
      expect(health.data).toMatchObject({ healthy: true })
      expect(yield* firstEvent((signal) => sdk.global.event({ signal }))).toMatchObject({
        payload: { type: "server.connected" },
      })
      expect(log.response.status).toBe(200)
      expect(log.data).toBe(true)
      yield* expectStatus(() => sdk.auth.set({ providerID: "test" }), 400)
    }),
  )

  httpapiInstance(
    "uses the generated SDK for safe instance routes",
    { serverPath: "raw", git: false, setup: writeStandardFiles },
    ({ sdk }) =>
      Effect.gen(function* () {
        const file = yield* call(() => sdk.file.read({ path: "hello.txt" }))
        const session = yield* call(() => sdk.session.create({ title: "sdk" }))
        const listed = yield* call(() => sdk.session.list({ roots: true, limit: 10 }))

        expect(file.response.status).toBe(200)
        expect(file.data).toMatchObject({ content: "hello" })
        expect(session.response.status).toBe(200)
        expect(session.data).toMatchObject({ title: "sdk" })
        expect(listed.response.status).toBe(200)
        expect(listed.data?.map((item) => item.id)).toContain(session.data?.id)

        yield* Effect.all([
          expectStatus(() => sdk.project.current(), 200),
          expectStatus(() => sdk.config.get(), 200),
          expectStatus(() => sdk.config.providers(), 200),
          expectStatus(() => sdk.find.files({ query: "hello", limit: 10 }), 200),
        ])
      }),
  )

  serverPathParity("matches generated SDK global and control behavior", (serverPath) =>
    Effect.gen(function* () {
      const sdk = client(serverPath)
      const health = yield* capture(() => sdk.global.health())
      const log = yield* capture(() => sdk.app.log({ service: "sdk-parity", level: "info", message: "hello" }))
      const invalidAuth = yield* capture(() => sdk.auth.set({ providerID: "test" }))

      return {
        statuses: statuses({ health, log, invalidAuth }),
        health: record(health.data).healthy,
        log: log.data,
      }
    }),
  )

  serverPathParity("matches generated SDK global event stream", (serverPath) =>
    firstEvent((signal) => client(serverPath).global.event({ signal })).pipe(
      Effect.map((event) => ({ type: record(record(event).payload).type })),
    ),
  )

  serverPathParity("matches generated SDK instance event stream", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      firstEvent((signal) => sdk.event.subscribe(undefined, { signal })).pipe(
        Effect.map((event) => ({ type: record(record(event).payload).type })),
      ),
    ),
  )

  serverPathParity("matches generated SDK missing session errors", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const sessionID = "ses_missing"
        const expected = {
          name: "NotFoundError",
          data: { message: `Session not found: ${sessionID}` },
        }
        const missing = yield* capture(() => sdk.session.get({ sessionID }))
        const thrown = yield* captureThrown(() => sdk.session.get({ sessionID }, { throwOnError: true }))

        // Result-tuple path: error body is preserved as-is so existing
        // consumers reading `result.error.name` / `JSON.stringify(error)`
        // keep working byte-for-byte.
        expect(missing.error).toEqual(expected)
        // throwOnError path: SDK wraps the body in a real Error with the
        // server's message, with the original parsed body preserved under
        // `.cause.body`.
        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe(expected.data.message)
        expect(((thrown as Error).cause as { body: unknown }).body).toEqual(expected)
        return {
          status: missing.status,
          error: missing.error,
          thrown,
        }
      }),
    ),
  )

  serverPathParity("formats missing session validation errors for -s", (serverPath) =>
    withStandardProject(serverPath, ({ directory }) =>
      Effect.gen(function* () {
        const sessionID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
        const thrown = yield* captureThrown(() =>
          validateSession({
            url: "http://localhost",
            directory,
            sessionID,
            fetch: serverFetch(serverPath),
          }),
        )
        expect(errorMessage(thrown)).toBe(`Session not found: ${sessionID}`)
        return errorMessage(thrown)
      }),
    ),
  )

  httpapiInstance(
    "uses generated SDK basic auth behavior",
    { serverPath: "raw", setup: writeStandardFiles },
    ({ directory }) =>
      Effect.gen(function* () {
        const missing = yield* capture(() =>
          client("raw", directory, { password: "secret" }).file.read({ path: "hello.txt" }),
        )
        const bad = yield* capture(() =>
          client("raw", directory, {
            password: "secret",
            headers: { authorization: authorization("redcode", "wrong") },
          }).file.read({ path: "hello.txt" }),
        )
        const good = yield* capture(() =>
          client("raw", directory, {
            password: "secret",
            headers: { authorization: authorization("redcode", "secret") },
          }).file.read({ path: "hello.txt" }),
        )

        return {
          statuses: statuses({ missing, bad, good }),
          content: record(good.data).content,
        }
      }),
  )

  serverPathParity("matches generated SDK instance read routes", (serverPath) =>
    withProject(serverPath, { git: true, setup: writeStandardFiles }, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const project = yield* capture(() => sdk.project.current())
        const projects = yield* capture(() => sdk.project.list())
        const paths = yield* capture(() => sdk.path.get())
        const config = yield* capture(() => sdk.config.get())
        const providers = yield* capture(() => sdk.config.providers())
        const file = yield* capture(() => sdk.file.read({ path: "hello.txt" }))
        const files = yield* capture(() => sdk.file.list({ path: "." }))
        const fileStatus = yield* capture(() => sdk.file.status())
        const findFiles = yield* capture(() => sdk.find.files({ query: "hello", limit: 10 }))
        const findText = yield* capture(() => sdk.find.text({ pattern: "sdk-parity" }))
        const agents = yield* capture(() => sdk.app.agents())
        const skills = yield* capture(() => sdk.app.skills())
        const instructions = yield* capture(() => sdk.app.instructions())
        const tools = yield* capture(() => sdk.tool.ids())
        const vcs = yield* capture(() => sdk.vcs.get())
        const formatter = yield* capture(() => sdk.formatter.status())
        const lsp = yield* capture(() => sdk.lsp.status())

        return {
          statuses: statuses({
            project,
            projects,
            paths,
            config,
            providers,
            file,
            files,
            fileStatus,
            findFiles,
            findText,
            agents,
            skills,
            instructions,
            tools,
            vcs,
            formatter,
            lsp,
          }),
          project: { worktreeSelected: record(project.data).worktree === directory },
          paths: { directorySelected: record(paths.data).directory === directory },
          file: record(file.data).content,
          hasProject: array(projects.data).length > 0,
          foundFile: JSON.stringify(findFiles.data).includes("hello.txt"),
          foundText: JSON.stringify(findText.data ?? null).includes("sdk-parity"),
          listedFile: JSON.stringify(files.data).includes("hello.txt"),
          vcs: { hasBranch: typeof record(vcs.data).branch === "string" },
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK session lifecycle routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const parent = yield* capture(() => sdk.session.create({ title: "parent" }))
        const parentID = String(record(parent.data).id)
        const child = yield* capture(() => sdk.session.create({ title: "child", parentID }))
        const childID = String(record(child.data).id)
        const get = yield* capture(() => sdk.session.get({ sessionID: parentID }))
        const update = yield* capture(() => sdk.session.update({ sessionID: parentID, title: "renamed" }))
        const roots = yield* capture(() => sdk.session.list({ roots: true, limit: 10 }))
        const all = yield* capture(() => sdk.session.list({ roots: false, limit: 10 }))
        const children = yield* capture(() => sdk.session.children({ sessionID: parentID }))
        const todo = yield* capture(() => sdk.session.todo({ sessionID: parentID }))
        const status = yield* capture(() => sdk.session.status())
        const messages = yield* capture(() => sdk.session.messages({ sessionID: parentID }))
        const missingGet = yield* capture(() => sdk.session.get({ sessionID: "ses_missing" }))
        const missingMessages = yield* capture(() => sdk.session.messages({ sessionID: "ses_missing", limit: 2 }))
        const invalidCursor = yield* capture(() =>
          sdk.session.messages({ sessionID: parentID, limit: 2, before: "bad" }),
        )
        const deleted = yield* capture(() => sdk.session.delete({ sessionID: childID }))
        const getDeleted = yield* capture(() => sdk.session.get({ sessionID: childID }))

        return {
          statuses: statuses({
            parent,
            child,
            get,
            update,
            roots,
            all,
            children,
            todo,
            status,
            messages,
            missingGet,
            missingMessages,
            invalidCursor,
            deleted,
            getDeleted,
          }),
          getTitle: record(get.data).title,
          updatedTitle: record(update.data).title,
          rootTitles: sessionTitles(roots.data),
          allTitles: sessionTitles(all.data),
          childCount: array(children.data).length,
          todoCount: array(todo.data).length,
          messageCount: array(messages.data).length,
        }
      }),
    ),
  )

  httpapi(
    "archived Code sessions are filtered before the page limit",
    withStandardProject("default", ({ sdk, directory }) =>
      Effect.gen(function* () {
        const options = { throwOnError: true } as const
        const { data: older } = yield* call(() => sdk.session.create({ title: "Older archive" }, options))
        yield* call(() => sdk.session.update({ sessionID: older.id, time: { archived: Date.now() } }, options))
        const { data: active } = yield* call(() => sdk.session.create({ title: "Recent active task" }, options))
        const origin = "http://127.0.0.1:5173"
        const page = (filters: { archived?: boolean; archivedOnly?: boolean; mode?: "chat" | "code" }) =>
          call(() =>
            sdk.experimental.session.list(
              { directory, roots: true, limit: 1, ...filters },
              { ...options, headers: { origin } },
            ),
          )
        const first = yield* page({ archived: true })
        expect(first.data.map((s) => s.id)).toEqual([active.id])
        expect(first.response.headers.get("access-control-allow-origin")).toBe(origin)
        expect(first.response.headers.get("x-next-cursor")).toBeTruthy()
        expect(first.response.headers.get("access-control-expose-headers")?.toLowerCase()).toBe("x-next-cursor")
        expect((yield* page({ archivedOnly: true, mode: "code" })).data.map((s) => s.id)).toEqual([older.id])
        expect((yield* page({ archivedOnly: true, mode: "chat" })).data).toEqual([])
      }),
    ),
  )

  httpapi(
    "session search only links to messages on the selected branch",
    withStandardProject("default", ({ sdk, directory }) =>
      Effect.gen(function* () {
        const options = { throwOnError: true } as const
        const { data: session } = yield* call(() => sdk.session.create({ title: "versions" }, options))
        const sessionID = session.id
        const saved = yield* seedMessage(directory, sessionID)
        const current = yield* seedMessage(directory, sessionID)
        const hits = () => call(() => sdk.session.query({ sessionID, q: "seeded message" }, options))

        markIslandRows([{ info: saved.message }])
        expect((yield* hits()).data.results.map((hit) => hit.messageID)).toEqual([current.message.id])
        unmarkIslandRows([{ info: saved.message }])
        markIslandRows([{ info: current.message }])
        expect((yield* hits()).data.results.map((hit) => hit.messageID)).toEqual([saved.message.id])
      }),
    ),
  )

  serverPathParity("matches generated SDK session message and part routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "messages" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)
        const list = yield* capture(() => sdk.session.messages({ sessionID }))
        const page = yield* capture(() => sdk.session.messages({ sessionID, limit: 1 }))
        const message = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partUpdate = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated message" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        const updated = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partDelete = yield* capture(() =>
          sdk.part.delete({ sessionID, messageID: seeded.message.id, partID: seeded.part.id }),
        )
        const withoutPart = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const deleteMessage = yield* capture(() =>
          sdk.session.deleteMessage({ sessionID, messageID: seeded.message.id }),
        )
        const missingMessage = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))

        return {
          statuses: statuses({
            session,
            list,
            page,
            message,
            partUpdate,
            updated,
            partDelete,
            withoutPart,
            deleteMessage,
            missingMessage,
          }),
          listCount: array(list.data).length,
          pageCount: array(page.data).length,
          initialText: firstPartText(message.data),
          updatedText: firstPartText(updated.data),
          partCountAfterDelete: array(record(withoutPart.data).parts).length,
        }
      }),
    ),
  )

  httpapiInstance(
    "projects large edit diagnostics for display while preserving raw session history",
    { serverPath: "default", git: false },
    ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* call(() => sdk.session.create({ title: "large history" }, { throwOnError: true }))
        const sessionID = session.data.id
        const older = yield* seedMessage(directory, sessionID)
        const { message, part } = yield* seedMessage(directory, sessionID)
        const filePath = "scene.ts"
        const errors = Array.from({ length: 6 }, (_, i) => ({ severity: 1, message: `error ${i}` }))
        const diagnostics = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`file-${i}.ts`, errors]))
        diagnostics[filePath] = [{ severity: 2, message: "warning" }, ...errors]
        const partID = PartID.ascending()
        const tool = {
          type: "tool" as const,
          tool: "edit",
          callID: "fixture",
          id: partID,
          sessionID,
          messageID: message.id,
          state: {
            status: "completed" as const,
            input: { filePath },
            title: "edit",
            output: "done",
            time: { start: 1, end: 2 },
            metadata: { diagnostics, extra: "preserved" },
          },
        }
        yield* call(() =>
          sdk.part.update({ sessionID, messageID: message.id, partID, part: tool }, { throwOnError: true }),
        )
        const raw = yield* call(() => sdk.session.message({ sessionID, messageID: message.id }, { throwOnError: true }))
        const display = yield* call(() =>
          sdk.session.message({ sessionID, messageID: message.id, view: "display" }, { throwOnError: true }),
        )
        const expected = {
          ...tool,
          state: { ...tool.state, metadata: { diagnostics: { [filePath]: errors.slice(0, 3) }, extra: "preserved" } },
        }
        expect(raw.data.parts).toEqual([part, tool])
        expect(display.data.parts).toEqual([part, expected])
        expect(Buffer.byteLength(JSON.stringify(display.data)) * 10).toBeLessThan(
          Buffer.byteLength(JSON.stringify(raw.data)),
        )
        const list = yield* call(() => sdk.session.messages({ sessionID, view: "display" }, { throwOnError: true }))
        expect(list.data.find((item) => item.info.id === message.id)).toEqual(display.data)
        const page = yield* call(() =>
          sdk.session.messages({ sessionID, view: "display", limit: 1 }, { throwOnError: true }),
        )
        expect(page.data).toEqual([display.data])
        const before = page.response.headers.get("X-Next-Cursor")
        expect(before).toBeTruthy()
        const next = yield* call(() =>
          sdk.session.messages({ sessionID, view: "display", limit: 1, before: before! }, { throwOnError: true }),
        )
        expect(next.data[0].info.id).toBe(older.message.id)
        const full = yield* call(() => sdk.session.messages({ sessionID }, { throwOnError: true }))
        expect(full.data.find((item) => item.info.id === message.id)).toEqual(raw.data)
      }),
  )

  // Regression: SyncEvent must publish on the same ProjectBus the /event handler
  // subscribes to, AND the /event stream must forward handler ALS/context into the
  // body-pump fiber. Drives the full SDK → /event → Session.updatePart → sync.run →
  // bus.publish → SDK subscriber path. Goes red if either the publisher uses a
  // different bus instance (Bug 2 / pre-#27825) or the stream loses context (Bug 1 /
  // pre-#27425).
  serverPathParity("streams sync-backed part updates to /event subscribers", (serverPath) =>
    withStandardProject(serverPath, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "sync-backed part event" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)

        const controller = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
        const events = yield* call(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
        yield* Effect.addFinalizer(() =>
          call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
        )

        const ready = yield* Deferred.make<void>()
        const received = yield* Deferred.make<unknown>()

        yield* call(async () => {
          for await (const event of events.stream) {
            const payload = record(event).payload ?? event
            const type = record(payload).type
            if (type === "server.connected") {
              Deferred.doneUnsafe(ready, Effect.void)
              continue
            }
            if (type === MessageV2.Event.PartUpdated.type) {
              Deferred.doneUnsafe(received, Effect.succeed(payload))
              return
            }
          }
        }).pipe(Effect.forkScoped)

        yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for /event server.connected", "2 seconds")

        const updated = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated via sync" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        expect(updated.status).toBe(200)

        const event = yield* awaitWithTimeout(
          Deferred.await(received),
          "timed out waiting for message.part.updated bus payload over /event",
          "5 seconds",
        )
        const properties = record(record(event).properties)
        expect(record(properties.part)).toMatchObject({ id: seeded.part.id, type: "text" })
        return { type: record(event).type, partType: record(properties.part).type }
      }),
    ),
  )

  serverPathParity("matches generated SDK prompt no-reply routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "prompt" }))
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        )
        const asyncPrompt = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "async hello" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))

        return {
          statuses: statuses({ session, prompt, asyncPrompt, messages }),
          promptRole: record(record(prompt.data).info).role,
          messageCount: array(messages.data).length,
          messageTexts: array(messages.data)
            .flatMap((item) => array(record(item).parts))
            .map((part) => record(part).text)
            .filter((text): text is string => typeof text === "string")
            .sort(),
        }
      }),
    ),
  )

  for (const outcome of ["success", "failure", "cancel"] as const) {
    httpapi(
      `background compaction survives disconnect and reports ${outcome}`,
      withFakeLlm("default", ({ sdk, directory, llm }) =>
        Effect.gen(function* () {
          const session = yield* call(() =>
            sdk.session.create({ title: "background compaction" }, { throwOnError: true }),
          )
          const sessionID = session.data.id
          const model = { providerID: "test", modelID: "test-model" }
          yield* llm.text("Initial reply.")
          yield* call(() =>
            sdk.session.prompt(
              {
                sessionID,
                agent: "build",
                model,
                parts: [{ type: "text", text: "Prepare this conversation for compaction." }],
              },
              { throwOnError: true },
            ),
          )

          let release!: () => void
          const gate = new Promise<void>((resolve) => (release = resolve))
          yield* Effect.addFinalizer(() => Effect.sync(release))
          if (outcome === "failure") yield* llm.error(400, { error: { message: "rejected summary" } })
          else yield* llm.hold("## Goal\nPreserve the initial conversation.", gate)
          const input = { sessionID, background: true, ...model }
          const controller = new AbortController()
          const accepted = yield* call(() =>
            sdk.session.summarize(input, { signal: controller.signal, throwOnError: true }),
          )
          expect(accepted.data).toBe(true)
          controller.abort()

          const reconnected = client("default", directory)
          const state = () => reconnected.session.get({ sessionID }, { throwOnError: true })
          yield* llm.wait(2).pipe(Effect.timeout("10 seconds"))
          if (outcome !== "failure") {
            expect((yield* call(state)).data.time.compacting).toBeGreaterThan(0)
            expect((yield* call(() => reconnected.session.summarize(input, { throwOnError: true }))).data).toBe(true)
          }
          if (outcome === "cancel") yield* call(() => reconnected.session.abort({ sessionID }, { throwOnError: true }))
          release()
          yield* call(state).pipe(
            Effect.repeat({ while: (value) => !!value.data.time.compacting, schedule: Schedule.spaced(25) }),
            Effect.timeout("10 seconds"),
          )
          const messages = (yield* call(() => reconnected.session.messages({ sessionID }, { throwOnError: true }))).data
          const markers = messages.flatMap((item) => item.parts.filter((part) => part.type === "compaction"))
          expect(markers).toHaveLength(1)
          if (outcome === "success") expect(markers[0]?.tokens_after).toBeDefined()
          else {
            expect(markers[0]?.tokens_after).toBeUndefined()
            expect(messages.some(({ info }) => info.role === "assistant" && info.summary && info.error)).toBe(true)
          }
        }),
      ),
    )
  }

  for (const interrupted of [false, true]) {
    httpapi(
      interrupted
        ? "cancels background compaction still waiting for the active turn"
        : "runs accepted background compaction after the active turn fails",
      withFakeLlm("default", ({ sdk, llm }) =>
        Effect.gen(function* () {
          const options = { throwOnError: true } as const
          const { data: session } = yield* call(() => sdk.session.create({ title: "Compaction during a turn" }, options))
          const sessionID = session.id
          const model = { providerID: "test", modelID: "test-model" }
          const prompt = (text: string) =>
            call(() => sdk.session.prompt({ sessionID, agent: "build", model, parts: [{ type: "text", text }] }, options))

          yield* llm.text("Retain this answer in the summary.")
          yield* prompt("Set up history.")
          const gate = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          yield* llm.push(reply().wait(gate.promise).streamError("The active turn failed."))
          const active = yield* prompt("Hold this request until the compaction is accepted.").pipe(Effect.forkChild)
          yield* llm.wait(2).pipe(Effect.timeout("10 seconds"))
          yield* llm.text("## Goal\nSummarize the prior work.")

          const summarize = () => sdk.session.summarize({ sessionID, ...model, background: true }, options)
          const accepted = yield* Effect.all([call(summarize), call(summarize)], { concurrency: 2 })
          expect(accepted.map((result) => result.data)).toEqual([true, true])
          const state = () => sdk.session.get({ sessionID }, options)
          expect((yield* call(state)).data.time.compacting).toBeGreaterThan(0)
          if (interrupted) yield* call(() => sdk.session.abort({ sessionID }, options))
          gate.resolve()
          const stopped = yield* Fiber.join(active)
          expect(stopped.data.info.error).toBeDefined()
          yield* call(state).pipe(
            Effect.repeat({ while: (value) => !!value.data.time.compacting, schedule: Schedule.spaced(25) }),
            Effect.timeout("10 seconds"),
          )
          const { data: messages } = yield* call(() => sdk.session.messages({ sessionID }, options))
          const markers = messages.flatMap(({ parts }) => parts.filter((part) => part.type === "compaction"))
          expect(yield* llm.calls).toBe(interrupted ? 2 : 3)
          expect(markers).toHaveLength(interrupted ? 0 : 1)
          if (!interrupted) expect(markers[0]?.tokens_after).toBeDefined()
        }),
      ),
    )
  }

  serverPathParity("matches generated SDK prompt streaming through fake LLM", (serverPath) =>
    withFakeLlm(serverPath, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("fake world", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "llm prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello llm" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))
        const inputs = yield* llm.inputs

        return {
          statuses: statuses({ session, prompt, messages }),
          calls: inputs.length,
          requestedModel: inputs[0]?.model,
          responseText: JSON.stringify(prompt.data).includes("fake world"),
          persistedText: JSON.stringify(messages.data).includes("fake world"),
          userText: JSON.stringify(messages.data).includes("hello llm"),
        }
      }),
    ),
  )

  httpapi(
    "includes project skills in REST API prompt context",
    withFakeLlmProject("default", { setup: writeProjectSkill }, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("skill context ok", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "project skill prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello skill context" }],
          }),
        )
        const inputs = yield* llm.inputs

        expect(session.status).toBe(200)
        expect(prompt.status).toBe(200)
        expect(JSON.stringify(inputs[0])).toContain("project-rest-skill")
      }),
    ),
  )

  serverPathParity("matches generated SDK TUI validation and command routes", (serverPath) =>
    withStandardProject(serverPath, ({ sdk }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "tui" }))
        const sessionID = String(record(session.data).id)
        const appendPrompt = yield* capture(() => sdk.tui.appendPrompt({ text: "hello" }))
        const openHelp = yield* capture(() => sdk.tui.openHelp())
        const openSessions = yield* capture(() => sdk.tui.openSessions())
        const openThemes = yield* capture(() => sdk.tui.openThemes())
        const openModels = yield* capture(() => sdk.tui.openModels())
        const submitPrompt = yield* capture(() => sdk.tui.submitPrompt())
        const clearPrompt = yield* capture(() => sdk.tui.clearPrompt())
        const executeCommand = yield* capture(() => sdk.tui.executeCommand({ command: "session_new" }))
        const showToast = yield* capture(() => sdk.tui.showToast({ title: "SDK", message: "hello", variant: "info" }))
        const selectSession = yield* capture(() => sdk.tui.selectSession({ sessionID }))
        const missingSession = yield* capture(() => sdk.tui.selectSession({ sessionID: "ses_missing" }))
        const invalidSession = yield* capture(() => sdk.tui.selectSession({ sessionID: "invalid_session_id" }))

        return {
          statuses: statuses({
            session,
            appendPrompt,
            openHelp,
            openSessions,
            openThemes,
            openModels,
            submitPrompt,
            clearPrompt,
            executeCommand,
            showToast,
            selectSession,
            missingSession,
            invalidSession,
          }),
          data: {
            appendPrompt: appendPrompt.data,
            openHelp: openHelp.data,
            openSessions: openSessions.data,
            openThemes: openThemes.data,
            openModels: openModels.data,
            submitPrompt: submitPrompt.data,
            clearPrompt: clearPrompt.data,
            executeCommand: executeCommand.data,
            showToast: showToast.data,
            selectSession: selectSession.data,
          },
        }
      }),
    ),
  )

  serverPathParity("matches generated SDK project git initialization", (serverPath) =>
    // bare: 本用例断言 initGit 前后的 vcs 变化，起点必须是真正没有 git 的目录
    withProject(serverPath, { bare: true }, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const before = yield* capture(() => sdk.project.current())
        const init = yield* capture(() => sdk.project.initGit())
        const after = yield* capture(() => sdk.project.current())

        return {
          statuses: statuses({ before, init, after }),
          before: {
            vcs: record(before.data).vcs ?? null,
            worktree: record(before.data).worktree,
          },
          init: {
            vcs: record(init.data).vcs,
            worktreeSelected: record(init.data).worktree === directory,
          },
          after: {
            vcs: record(after.data).vcs,
            worktreeSelected: record(after.data).worktree === directory,
          },
        }
      }),
    ),
  )
})
