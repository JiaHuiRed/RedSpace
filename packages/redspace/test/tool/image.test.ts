import { describe, expect } from "bun:test"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { IsolationBoundaryRef } from "@/effect/instance-ref"
import { Plugin } from "@/plugin"
import { SessionID, MessageID } from "@/session/schema"
import { ImageTool } from "@/tool/image"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAwZKP8MGSgAB84BmnnKnxUAAAAASUVORK5CYII="
const opaque =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAwZKP8MGSj/CM0CmVuv9O8AAAAASUVORK5CYII="
const jpeg =
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAEAAQMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k="
const it = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_image"),
  messageID: MessageID.make("msg_image"),
  agent: "redmind",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const fixture = Effect.fn("test.image.fixture")(function* (
  options: { onRequest?: () => Promise<void>; mime?: "image/png" | "image/jpeg"; payload?: string } = {},
) {
  const calls: string[] = []
  const payload = options.payload ?? (options.mime === "image/jpeg" ? jpeg : png)
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const route = new URL(req.url).pathname
          calls.push(route)
          if (options.onRequest) await options.onRequest()
          if (route.endsWith("/edits")) {
            const source = (await req.formData()).get("image")
            if (!(source instanceof File) || Buffer.from(await source.arrayBuffer()).toString("base64") !== png)
              return new Response(null, { status: 422 })
          }
          return Response.json({ data: [{ b64_json: payload }] })
        },
      }),
    ),
    (s) =>
      Effect.promise(async () => {
        await s.stop(true)
      }),
  )
  const info = yield* ImageTool.pipe(
    Effect.provide(
      Layer.mergeAll(
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              image_generation: { provider: "studio", model: "paint", auth: "api" },
              provider: { studio: { options: { baseURL: server.url.href, apiKey: "test-only" } } },
            }),
        }),
        Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined), all: () => Effect.succeed({}) }),
        Layer.mock(Plugin.Service)({ list: () => Effect.succeed([]) }),
      ),
    ),
  )
  const tool = yield* Tool.init(info)
  return { run: (args: Tool.InferParameters<typeof ImageTool>, context = ctx) => tool.execute(args, context), calls }
})

describe("tool.image", () => {
  it.instance("saves a new image and edits that file without returning pixels in either tool result", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { run, calls } = yield* fixture()
      const first = yield* run({ prompt: "Draw a cat" })
      const source = first.metadata.filepath
      expect(path.dirname(source)).toBe(path.join(directory, ".redcode", "temp"))
      const next = yield* run({ prompt: "Change its scarf", image: source, output: "exports/edited.png" })
      expect(calls).toEqual(["/images/generations", "/images/edits"])
      expect(next.metadata.filepath).toBe(path.join(directory, "exports", "edited.png"))
      for (const result of [first, next]) {
        expect(JSON.stringify(result)).not.toContain(png)
        expect(result.attachments ?? []).toHaveLength(0)
        expect(result.metadata.mime).toBe("image/png")
        expect(result.output).toContain(result.metadata.filepath)
        expect((yield* Effect.promise(() => fs.readFile(result.metadata.filepath))).toString("base64")).toBe(png)
      }
    }),
  )

  it.instance("does not send a request after denied read/write/image permission or overwrite a source", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { run, calls } = yield* fixture()
      const image = path.join(directory, "original.png")
      yield* Effect.promise(() => fs.writeFile(image, Buffer.from(png, "base64")))
      for (const permission of ["image", "read", "edit"]) {
        const result = yield* Effect.exit(
          run(
            { prompt: "edit", image },
            {
              ...ctx,
              ask: (req) => (req.permission === permission ? Effect.die(new Error("denied")) : Effect.void),
            },
          ),
        )
        expect(Exit.isFailure(result)).toBe(true)
      }
      expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "edit", output: image, image })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "edit", image, output: "x.ts" })))).toBe(true)
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "fake.png"), "not an image"))
      expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "edit", image: "fake.png" })))).toBe(true)
      expect(calls).toEqual([])
      expect((yield* Effect.promise(() => fs.readFile(image))).toString("base64")).toBe(png)
    }),
  )

  it.instance("requires external directory permission and never writes outside an isolated workspace", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const other = yield* tmpdirScoped()
      const { run, calls } = yield* fixture()
      const alias = path.join(directory, "linked")
      yield* Effect.promise(() => fs.symlink(other, alias, process.platform === "win32" ? "junction" : "dir"))
      const dest = path.join(alias, "new", "output.png")
      const req = { prompt: "cat", output: dest }
      const seen: string[] = []
      const result = yield* Effect.exit(
        run(req, {
          ...ctx,
          ask: (request) => {
            seen.push(request.permission)
            return request.permission === "external_directory" ? Effect.die(new Error("denied")) : Effect.void
          },
        }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(seen).toContain("external_directory")
      const isolated = yield* Effect.exit(run(req).pipe(Effect.provideService(IsolationBoundaryRef, directory)))
      expect(Exit.isFailure(isolated)).toBe(true)
      expect(calls).toEqual([])
    }),
  )

  it.instance("never replaces a file created while the provider was rendering", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const output = path.join(directory, "claimed.png")
      const { run, calls } = yield* fixture({ onRequest: () => fs.writeFile(output, "another job") })
      const aborted = { ...ctx, abort: AbortSignal.abort() }
      expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "cat", output }, aborted)))).toBe(true)
      expect(calls).toEqual([])
      expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "cat", output })))).toBe(true)
      expect(calls).toEqual(["/images/generations"])
      expect(yield* Effect.promise(() => fs.readFile(output, "utf8"))).toBe("another job")
    }),
  )

  it.instance("saves a generated image under its native extension when it differs from the requested one", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { run, calls } = yield* fixture({ mime: "image/jpeg" })
      const result = yield* run({ prompt: "portrait", output: "exports/知微.png" })
      expect(calls).toEqual(["/images/generations"])
      expect(result.metadata.filepath).toBe(path.join(directory, "exports", "知微.jpg"))
      expect(result.metadata.mime).toBe("image/jpeg")
      expect(result.output).toContain("saved with .jpg instead of .png")
      expect((yield* Effect.promise(() => fs.readFile(result.metadata.filepath))).toString("base64")).toBe(jpeg)
      expect(
        yield* Effect.promise(() =>
          fs
            .stat(path.join(directory, "exports", "知微.png"))
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false)
    }),
  )

  it.instance("rejects contradictory production specs without sending a request", () =>
    Effect.gen(function* () {
      const { run, calls } = yield* fixture()
      for (const args of [
        { background: "transparent", output_format: "jpeg" },
        { background: "transparent", output: "asset.jpg" },
        { output_format: "webp", output: "asset.png" },
      ] as const) {
        expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "portrait", ...args })))).toBe(true)
      }
      expect(calls).toEqual([])
    }),
  )

  it.instance("delivers verified transparent WebP from a single PNG response, including on edit", () =>
    Effect.gen(function* () {
      const { run, calls } = yield* fixture()
      const first = yield* run({ prompt: "portrait", background: "transparent", output_format: "png" })
      const next = yield* run({
        prompt: "blue scarf",
        image: first.metadata.filepath,
        output: "art/unit.webp",
        background: "transparent",
        output_format: "webp",
      })
      expect(calls).toEqual(["/images/generations", "/images/edits"])
      expect(next.metadata).toMatchObject({ mime: "image/webp", verifiedBackground: "transparent" })
      const bytes = yield* Effect.promise(() => fs.readFile(next.metadata.filepath))
      expect(bytes.toString("ascii", 8, 12)).toBe("WEBP")
      const { PhotonImage } = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const asset = PhotonImage.new_from_byteslice(bytes)
      try {
        expect([...asset.get_raw_pixels()].filter((_, index) => index % 4 === 3)).toEqual([255, 0])
      } finally {
        asset.free()
      }
    }),
  )

  it.instance("keeps a rejected opaque original separate from the requested asset, without retry", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { run, calls } = yield* fixture({ payload: opaque })
      const exit = yield* Effect.exit(
        run({
          prompt: "portrait",
          background: "transparent",
          output: "art/unit.png",
        }),
      )
      const files = yield* Effect.promise(() => fs.readdir(path.join(directory, "art")))
      expect(files).toHaveLength(1)
      expect(files[0]).not.toBe("unit.png")
      const file = path.join(directory, "art", files[0]!)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(file)
      expect((yield* Effect.promise(() => fs.readFile(file))).toString("base64")).toBe(opaque)
      expect(calls).toEqual(["/images/generations"])
    }),
  )

  it.instance("rejects a truncated source image before spending a provider request", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const { run, calls } = yield* fixture()
      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "truncated.png"), Buffer.from(png, "base64").subarray(0, 12)),
      )
      expect(Exit.isFailure(yield* Effect.exit(run({ prompt: "edit", image: "truncated.png" })))).toBe(true)
      expect(calls).toEqual([])
    }),
  )
})
