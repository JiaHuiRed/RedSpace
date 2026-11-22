import { expect } from "bun:test"
import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

cliIt.live(
  "restarting the backend preserves the system and historical request prefix after the pin budget fills",
  ({ redcode, llm, home }) =>
    Effect.gen(function* () {
      const memory = path.join(home, ".redcode", "MEMORY.md")
      const plugin = path.join(home, "fixture-plugin.mjs")
      const pins = path.join(home, "pins")
      const memoryBefore = "RESTART_MEMORY_BEFORE"
      const memoryAfter = "RESTART_MEMORY_AFTER"
      const earlyPrompt = "Keep this early turn in history"
      const rewrite = "[RESTART_PLUGIN_REWRITE]"
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(memory), { recursive: true })
        await Bun.write(memory, memoryBefore)
        await Bun.write(
          plugin,
          `export const fixture = async () => ({
            "experimental.chat.messages.transform": (_input, output) => {
              const user = output.messages.findLast(message => message.info.role === "user")
              const text = user?.parts.find(part => part.type === "text" && part.text === ${JSON.stringify(earlyPrompt)})
              if (text) text.text += ${JSON.stringify(rewrite)}
            },
          })`,
        )
      })
      const env = {
        REDCODE_DB: path.join(home, "restart.db"),
        REDCODE_PROMPT_PIN_DIR: pins,
        REDCODE_PURE: "0",
        REDCODE_DISABLE_PLUGIN_DEP_INSTALL: "1",
        REDCODE_CONFIG_CONTENT: JSON.stringify({
          ...testProviderConfig(llm.url),
          snapshot: false,
          plugin: [pathToFileURL(plugin).href],
        }),
      }
      const start = () => redcode.serve({ env, hostname: "127.0.0.1" })
      const first = yield* start()
      const client = (url: string) => createOpencodeClient({ baseUrl: url, directory: home })
      const warm = client(first.url)
      const create = (sdk: ReturnType<typeof client>) =>
        Effect.promise(async () => {
          const response = await sdk.session.create({ title: "Prefix restart", mode: "code" }, { throwOnError: true })
          return response.data.id
        })
      const sessionID = yield* create(warm)

      const send = Effect.fnUntraced(function* (sdk: ReturnType<typeof client>, id: string, text: string) {
        yield* llm.text("Reply from the test model.")
        const response = yield* Effect.promise(() =>
          sdk.session.prompt(
            {
              sessionID: id,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text }],
            },
            { throwOnError: true },
          ),
        )
        expect(response.data.info.error).toBeUndefined()
        return (yield* llm.hits).at(-1)!.body
      })

      yield* send(warm, sessionID, earlyPrompt)
      yield* Effect.promise(() => Bun.write(memory, memoryAfter))
      for (const label of ["first bulk", "second bulk"])
        yield* send(warm, sessionID, label + "x".repeat(200 * 1024))
      const before = yield* send(warm, sessionID, "last bulk" + "x".repeat(200 * 1024))
      expect(JSON.stringify(before.messages)).toContain(memoryBefore)
      expect(JSON.stringify(before.messages)).toContain(earlyPrompt + rewrite)

      const file = path.join(pins, `${sessionID}.json`)
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 4_000
        while (Date.now() < deadline) {
          const data = await Bun.file(file).json().catch(() => undefined)
          if (data?.messages && JSON.stringify(data.messages).includes("last bulk")) return
          await Bun.sleep(25)
        }
        throw new Error("backend did not write the latest prompt pin")
      })

      first.kill()
      yield* Effect.promise(() => first.exited)
      const cold = client((yield* start()).url)
      const after = yield* send(cold, sessionID, "Continue after process exit")
      const oldMessages = before.messages as unknown[]
      const resumed = after.messages as unknown[]
      expect(after.tools).toEqual(before.tools)
      expect(after.model).toEqual(before.model)
      const resumedPrefix = JSON.stringify(resumed.slice(0, oldMessages.length))
      expect(resumedPrefix.includes(earlyPrompt + rewrite)).toBe(true)
      expect(resumedPrefix.includes(memoryBefore) && !resumedPrefix.includes(memoryAfter)).toBe(true)
      expect(resumedPrefix === JSON.stringify(oldMessages)).toBe(true)

      const fresh = yield* send(cold, yield* create(cold), "New session after restart")
      expect(JSON.stringify(fresh.messages)).toContain(memoryAfter)
    }),
  60_000,
)
