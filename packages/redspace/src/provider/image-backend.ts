import type { AuthHook, Hooks } from "@redcode-ai/plugin"
import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { fetchWithProxy } from "@/util/proxy"
import { requestImage, type ImageResult, type ImageSource } from "./image-wire"

// 261127 Red 生图后端解析：供应商无关。只按显式配置或「唯一一个已登录 OAuth 插件」选后端，
// 不做任何自动降级。API 路径只走调用方明确配置的 baseURL/api 与凭据；OAuth 路径只交给
// 插件自己声明的 image 能力（插件内部负责官方目标与账号头）。协议细节在 image-wire.ts。
//
// 工具的 model 参数原样进入 image-wire 的 JSON `model` 字段：第三方 image ID 可能合法带
// 命名空间/斜杠，它不能也不应该用来选 provider 或 URL。这里只区分「声明型号」（配置或
// 插件 defaultModel）与「实际请求型号」（调用方覆盖后的值）。

export class ImageBackendError extends Schema.TaggedError<ImageBackendError>()("ImageBackendError", {
  message: Schema.String,
}) {}

export type ImageGenerateInput = {
  prompt: string
  size?: string
  source?: ImageSource
  signal: AbortSignal
}

export type ImageBackend = {
  provider: string
  /** Effective wire model: declared model unless the caller requested another one. */
  model: string
  generate: (input: ImageGenerateInput) => Promise<ImageResult>
}

export type ImageResolver = (requestedModel?: string) => Effect.Effect<ImageBackend, ImageBackendError>

type ImageHook = NonNullable<AuthHook["image"]>
type ImageGenerationConfig = NonNullable<Config.Info["image_generation"]>
type ApiCredential = { kind: "static"; key: string } | { kind: "stored" }

const OFFICIAL_OPENAI_API_BASE = "https://api.openai.com/v1"
const OFFICIAL_OPENAI_HOST = "api.openai.com"

function disabledMessage(cfg: Config.Info, provider: string): string | undefined {
  if (cfg.enabled_providers && !cfg.enabled_providers.includes(provider))
    return `Provider "${provider}" is not in enabled_providers, so it cannot be used for image generation.`
  if (cfg.disabled_providers?.includes(provider))
    return `Provider "${provider}" is disabled by disabled_providers, so it cannot be used for image generation.`
  return undefined
}

function imageHook(plugins: Hooks[], provider: string): ImageHook | undefined {
  return plugins.find((entry) => entry.auth?.provider === provider && entry.auth.image)?.auth?.image
}

function apiBaseURL(cfg: Config.Info, provider: string): string | undefined {
  const configured = cfg.provider?.[provider]?.options?.baseURL ?? cfg.provider?.[provider]?.api
  const baseURL = typeof configured === "string" ? configured.trim() : ""
  if (baseURL) return baseURL
  // 显式 openai + api 未配地址时用官方 API；其他 provider 没有 endpoint 必须报错。
  return provider === "openai" ? OFFICIAL_OPENAI_API_BASE : undefined
}

function isOfficialOpenAI(baseURL: string): boolean {
  try {
    const url = new URL(baseURL)
    return url.protocol === "https:" && url.hostname === OFFICIAL_OPENAI_HOST && (url.port === "" || url.port === "443")
  } catch {
    return false // 非法 URL 按非官方源拒绝；错误信息不回显原值
  }
}

// 261127 Red Env 是外部输入边界。这里直接读进程环境，让 makeImageResolver 只依赖
// Config/Plugin/Auth（工具层不额外提供 Env.Service）；provider.<id>.env 仍按声明顺序取第一个可用值。
function envCredential(names: string[] | undefined): string | undefined {
  for (const name of names ?? []) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

export const makeImageResolver: Effect.Effect<ImageResolver, never, Config.Service | Plugin.Service | Auth.Service> =
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const auth = yield* Auth.Service

    const readAuth = (provider: string) =>
      auth.get(provider).pipe(
        Effect.mapError(
          (error) =>
            new ImageBackendError({
              message: `Failed to read stored credentials for "${provider}": ${error.message}`,
            }),
        ),
      )

    // 订阅插件的 getAuth 必须返回 OAuth：解析后 auth 被改成 API key 时 fail closed，
    // 不能让第三方订阅插件拿一把别的 key 去发图。
    const getOAuth = (provider: string) => async () => {
      const stored = await Effect.runPromise(auth.get(provider))
      if (stored?.type !== "oauth")
        throw new Error(
          `Provider "${provider}" is no longer logged in with OAuth; refusing to use a non-OAuth credential for image generation. Re-authenticate and retry.`,
        )
      return stored
    }

    const storedApiKey = async (provider: string) => {
      const stored = await Effect.runPromise(auth.get(provider))
      if (!stored || stored.type !== "api")
        throw new Error(
          `Image generation for "${provider}" was resolved with its stored API credential, but that credential is no longer an API key. Refusing to send; re-run image generation.`,
        )
      return stored.key
    }

    // 自动选中与显式配置共用这一个执行点：校验登录态、落到同一个插件 generate。
    const resolveOAuth = (provider: string, hook: ImageHook, declaredModel: string, requestedModel?: string) =>
      Effect.gen(function* () {
        const stored = yield* readAuth(provider)
        if (stored?.type !== "oauth")
          return yield* new ImageBackendError({
            message: `Provider "${provider}" is selected for OAuth image generation, but it is not logged in with OAuth. Run the provider's OAuth login, or set image_generation.auth to "api".`,
          })
        const model = requestedModel ?? declaredModel
        return {
          provider,
          model,
          generate: (input: ImageGenerateInput) => hook.generate({ ...input, model }, getOAuth(provider)),
        }
      })

    const resolveOAuthBackend = (
      cfg: Config.Info,
      plugins: Hooks[],
      configured: ImageGenerationConfig | undefined,
      requestedModel?: string,
    ) =>
      Effect.gen(function* () {
        if (configured) {
          const disabled = disabledMessage(cfg, configured.provider)
          if (disabled) return yield* new ImageBackendError({ message: disabled })
          const hook = imageHook(plugins, configured.provider)
          if (!hook)
            return yield* new ImageBackendError({
              message: `Provider "${configured.provider}" is configured for OAuth image generation, but no installed plugin declares OAuth image support for it. Install/update the provider plugin, or set image_generation.auth to "api" and configure provider.${configured.provider}.options.baseURL with an API key.`,
            })
          return yield* resolveOAuth(configured.provider, hook, configured.model, requestedModel)
        }

        const candidates: { provider: string; image: ImageHook }[] = []
        for (const entry of plugins) {
          const image = entry.auth?.image
          if (!image) continue
          const provider = entry.auth!.provider
          if (disabledMessage(cfg, provider)) continue
          const stored = yield* readAuth(provider)
          if (stored?.type !== "oauth") continue
          candidates.push({ provider, image })
        }

        if (candidates.length === 0)
          return yield* new ImageBackendError({
            message:
              "No image generation backend is available. Set image_generation = { provider, model, auth } in config, or log in to exactly one OAuth provider that declares image generation.",
          })
        if (candidates.length > 1)
          return yield* new ImageBackendError({
            message: `Multiple OAuth image providers are available (${candidates
              .map((candidate) => candidate.provider)
              .join(", ")}). Set image_generation = { provider, model, auth } to choose one; RedCode will not pick automatically.`,
          })

        const only = candidates[0]!
        return yield* resolveOAuth(only.provider, only.image, only.image.defaultModel, requestedModel)
      })

    const resolveApi = (cfg: Config.Info, configured: ImageGenerationConfig, requestedModel?: string) =>
      Effect.gen(function* () {
        const disabled = disabledMessage(cfg, configured.provider)
        if (disabled) return yield* new ImageBackendError({ message: disabled })

        const baseURL = apiBaseURL(cfg, configured.provider)
        if (!baseURL)
          return yield* new ImageBackendError({
            message: `Provider "${configured.provider}" is configured for API image generation, but no base URL is set. Set provider.${configured.provider}.options.baseURL or provider.${configured.provider}.api in config.`,
          })
        if (configured.provider === "openai" && !isOfficialOpenAI(baseURL))
          return yield* new ImageBackendError({
            message:
              'Refusing to send OpenAI credentials to a non-official endpoint. Provider "openai" may only use https://api.openai.com; use a dedicated provider id for custom OpenAI-compatible sites.',
          })

        const entry = cfg.provider?.[configured.provider]
        const configuredKey = entry?.options?.apiKey
        const credential: ApiCredential = yield* Effect.gen(function* () {
          if (typeof configuredKey === "string" && configuredKey) return { kind: "static", key: configuredKey } as const
          const stored = yield* readAuth(configured.provider)
          if (stored?.type === "api") return { kind: "stored" } as const
          const envKey = envCredential(
            entry?.env ?? (configured.provider === "openai" ? ["OPENAI_API_KEY"] : undefined),
          )
          if (envKey) return { kind: "static", key: envKey } as const
          if (stored?.type === "oauth")
            return yield* new ImageBackendError({
              message: `Provider "${configured.provider}" is logged in with OAuth, but image_generation.auth is "api". Set auth to "oauth" to use the subscription, or configure an API key via provider.${configured.provider}.options.apiKey / provider.${configured.provider}.env.`,
            })
          return yield* new ImageBackendError({
            message: `Provider "${configured.provider}" is configured for API image generation, but no API key was found. Set provider.${configured.provider}.options.apiKey, log in with an API key, or set one of provider.${configured.provider}.env.`,
          })
        })

        const model = requestedModel ?? configured.model
        return {
          provider: configured.provider,
          model,
          generate: async (input: ImageGenerateInput) => {
            const key = credential.kind === "stored" ? await storedApiKey(configured.provider) : credential.key
            return requestImage({
              baseURL,
              protocol: "openai",
              fetch: (url, init) => fetchWithProxy(url, init),
              headers: { Authorization: `Bearer ${key}` },
              model,
              prompt: input.prompt,
              size: input.size,
              source: input.source,
              signal: input.signal,
            })
          },
        }
      })

    return (requestedModel?: string) =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const configured = cfg.image_generation
        if (configured?.auth === "api") return yield* resolveApi(cfg, configured, requestedModel)
        return yield* resolveOAuthBackend(cfg, yield* plugin.list(), configured, requestedModel)
      })
  })

export * as ImageBackend from "./image-backend"
