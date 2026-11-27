import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Effect, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { makeImageResolver } from "@/provider/image-backend"
import { MAX_IMAGE_BYTES } from "@/provider/image-wire"
import { sniffAttachmentMime } from "@/util/media"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"

const filePath = Schema.NonEmptyString.check(Schema.isMaxLength(4096))
export const Parameters = Schema.Struct({
  prompt: Schema.NonEmptyString.check(Schema.isMaxLength(8192)).annotate({ description: "What to draw or change." }),
  image: Schema.optional(filePath).annotate({ description: "Local source image to edit. Omit to generate." }),
  model: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(256))).annotate({
    description: "Optional image model on the configured provider.",
  }),
  size: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(32))).annotate({
    description: "Optional size accepted by the provider, e.g. 1024x1024.",
  }),
  output: Schema.optional(filePath).annotate({ description: "Optional new output file; defaults to .redcode/temp/." }),
})

const extensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" } as const

// 261127 Red 图像是磁盘成果，不是历史附件。见 docs/notes/implemented/feature/2026-11-27-image-tool.md。
export const ImageTool = Tool.define(
  "image",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const resolve = yield* makeImageResolver
    return {
      description:
        "Generate an image, or edit one local image, with the configured image provider. Returns a new file path; use that path for follow-up edits.",
      parameters: Parameters,
      timeoutMs: 300_000,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const backend = yield* resolve(params.model)
          const sourcePath = params.image && AppFileSystem.resolveFrom(instance.directory, params.image)
          const mode = sourcePath ? "edit" : "generate"
          const requested = params.output && AppFileSystem.resolveFrom(instance.directory, params.output)
          const directory = yield* resolveDirectory(
            fs,
            requested ? path.dirname(requested) : path.join(instance.directory, ".redcode", "temp"),
          )
          const base = requested
            ? path.join(directory, path.basename(requested))
            : path.join(directory, `image-${randomUUID()}`)
          const paths = requested ? [base] : Object.values(extensions).map((ext) => base + ext)
          if (paths.some((file) => file.length > 4096))
            return yield* Effect.fail(new Error("Image output path exceeds 4096 characters."))
          if (requested && !Object.hasOwn(extensions, AppFileSystem.mimeType(base)))
            return yield* Effect.fail(new Error("Output must be a new PNG, JPEG or WebP file."))
          yield* assertExternalDirectoryEffect(ctx, directory, { kind: "directory", write: true })
          yield* ctx.ask({
            permission: "edit",
            patterns: [
              ...new Set(
                [...paths, ...(requested ? [requested] : [])].map((file) => path.relative(instance.worktree, file)),
              ),
            ],
            always: ["*"],
            metadata: { filepath: paths[0], mode },
          })
          if (requested && (yield* fs.exists(base)))
            return yield* Effect.fail(new Error(`Output already exists; choose a new file: ${base}`))

          const source = sourcePath ? yield* readSource(fs, ctx, instance.worktree, sourcePath) : undefined
          yield* ctx.ask({
            permission: "image",
            patterns: [`${backend.provider}/${backend.model}`],
            always: [`${backend.provider}/*`],
            metadata: {
              mode,
              provider: backend.provider,
              model: backend.model,
              ...(sourcePath && { source: sourcePath }),
            },
          })
          ctx.abort.throwIfAborted()
          const result = yield* Effect.promise(() =>
            backend.generate({
              prompt: params.prompt,
              size: params.size,
              source,
              signal: ctx.abort,
            }),
          )
          ctx.abort.throwIfAborted()
          if (
            !(result.bytes instanceof Uint8Array) ||
            result.bytes.byteLength > MAX_IMAGE_BYTES ||
            !Object.hasOwn(extensions, result.mime) ||
            sniffAttachmentMime(result.bytes, "") !== result.mime
          )
            return yield* Effect.fail(new Error("Image provider returned invalid or oversized image data."))
          if (requested && AppFileSystem.mimeType(base) !== result.mime)
            return yield* Effect.fail(
              new Error(
                `Provider returned ${result.mime}, not ${AppFileSystem.mimeType(base)}. Omit output to use its native format.`,
              ),
            )
          const filepath = requested ? base : base + extensions[result.mime]
          yield* fs.makeDirectory(directory, { recursive: true })
          yield* fs.writeFile(filepath, result.bytes, { flag: "wx", mode: 0o600 })
          return {
            title: path.basename(filepath),
            metadata: {
              mode,
              provider: backend.provider,
              model: backend.model,
              filepath,
              mime: result.mime,
              bytes: result.bytes.byteLength,
            },
            output: `${source ? "Edited" : "Generated"} image: ${filepath}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// A new file has no realpath. Check permissions against the nearest existing parent's
// real location so an in-workspace link cannot turn a new file into an external write.
function resolveDirectory(fs: AppFileSystem.Interface, directory: string): Effect.Effect<string, PlatformError> {
  return fs.realPath(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound" && path.dirname(directory) !== directory,
      () =>
        resolveDirectory(fs, path.dirname(directory)).pipe(
          Effect.map((parent) => path.join(parent, path.basename(directory))),
        ),
    ),
  )
}

const readSource = Effect.fn("ImageTool.readSource")(function* (
  fs: AppFileSystem.Interface,
  ctx: Tool.Context,
  worktree: string,
  source: string,
) {
  const real = yield* fs.realPath(source)
  yield* assertExternalDirectoryEffect(ctx, real)
  yield* ctx.ask({
    permission: "read",
    patterns: [...new Set([source, real].map((file) => path.relative(worktree, file)))],
    always: ["*"],
    metadata: { filepath: real },
  })
  if ((yield* fs.stat(real)).type !== "File")
    return yield* Effect.fail(new Error("Source image must be a regular file."))
  const bytes = Buffer.concat(yield* fs.stream(real, { bytesToRead: MAX_IMAGE_BYTES + 1 }).pipe(Stream.runCollect))
  if (bytes.length > MAX_IMAGE_BYTES) return yield* Effect.fail(new Error("Source image exceeds 20 MiB."))
  const mime = sniffAttachmentMime(bytes, "")
  if (!Object.hasOwn(extensions, mime))
    return yield* Effect.fail(new Error("Source image must contain PNG, JPEG or WebP data."))
  return { filename: path.basename(real), bytes, mime }
})
