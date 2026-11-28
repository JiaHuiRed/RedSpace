import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Effect, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { makeImageResolver } from "@/provider/image-backend"
import { MAX_IMAGE_BYTES } from "@/provider/image-wire"
import { completeImageMime } from "@/util/media"
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
          // 供应商不保证按请求的扩展名返回格式；stem 用于在同一目录落原生格式的替代路径。
          const stem = requested ? base.slice(0, base.length - path.extname(base).length) : base
          const paths = requested
            ? [...new Set([base, ...Object.values(extensions).map((ext) => stem + ext)])]
            : Object.values(extensions).map((ext) => base + ext)
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
          const mime = result.bytes instanceof Uint8Array ? completeImageMime(result.bytes) : undefined
          if (
            !(result.bytes instanceof Uint8Array) ||
            result.bytes.byteLength > MAX_IMAGE_BYTES ||
            !Object.hasOwn(extensions, result.mime) ||
            mime !== result.mime
          )
            return yield* Effect.fail(new Error("Image provider returned invalid, incomplete or oversized image data."))
          // 格式与用户指定的扩展名不同时保留原生格式落盘：额度已经花掉，不能因为扩展名猜错就丢图。
          const filepath =
            requested && AppFileSystem.mimeType(base) === result.mime ? base : stem + extensions[result.mime]
          if (requested && filepath !== base && (yield* fs.exists(filepath)))
            return yield* Effect.fail(new Error(`Output already exists; choose a new file: ${filepath}`))
          const notice =
            requested && filepath !== base
              ? ` (provider returned ${result.mime}; saved with ${path.extname(filepath)} instead of ${path.extname(base)})`
              : ""
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
            output: `${source ? "Edited" : "Generated"} image: ${filepath}${notice}`,
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
  const mime = completeImageMime(bytes)
  if (!mime) return yield* Effect.fail(new Error("Source image must be a complete PNG, JPEG or WebP image."))
  return { filename: path.basename(real), bytes, mime }
})
