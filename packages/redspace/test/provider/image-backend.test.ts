import { describe, expect, test } from "bun:test"
import type { ImageGenerationInput, ImageGenerationResult, Hooks } from "@redcode-ai/plugin"
import type { Auth as AuthV2 } from "@redcode-ai/sdk/v2"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { ImageBackendError, makeImageResolver } from "@/provider/image-backend"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function b64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64")
}

function serve(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request, new URL(request.url)) })
}

const OAUTH = { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 } as const

function imagePlugin(
  provider: string,
  options: {
    defaultModel?: string
    generate?: (input: ImageGenerationInput, auth: () => Promise<AuthV2>) => Promise<ImageGenerationResult>
  } = {},
): Hooks {
  return {
    auth: {
      provider,
      methods: [],
      image: {
        defaultModel: options.defaultModel ?? `${provider}-image-1`,
        generate: options.generate ?? (async () => ({ bytes: PNG, mime: "image/png" })),
      },
    },
  }
}

type Fixture = {
  config: Partial<Config.Info>
  plugins?: Hooks[]
  auth?: () => Record<string, Auth.Info>
}

const resolveEffect = (requestedModel?: string) =>
  Effect.gen(function* () {
    const resolve = yield* makeImageResolver
    return yield* resolve(requestedModel)
  })

const run = <A>(
  effect: Effect.Effect<A, ImageBackendError, Config.Service | Plugin.Service | Auth.Service>,
  input: Fixture,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Config.Service)({ get: () => Effect.succeed(input.config as Config.Info) }),
          Layer.mock(Plugin.Service)({ list: () => Effect.succeed(input.plugins ?? []) }),
          Layer.mock(Auth.Service)({
            get: (id: string) => Effect.succeed(input.auth?.()[id]),
            all: () => Effect.succeed(input.auth?.() ?? {}),
          }),
        ),
      ),
    ),
  )

describe("provider.image-backend", () => {
  test("API backend uses the selected provider's endpoint, model and stored key, never another provider's key", async () => {
    const requests: { path: string; authorization: string | null; body: Record<string, unknown> }[] = []
    const server = serve(async (request, url) => {
      requests.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      })
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    const auths: Record<string, Auth.Info> = {
      studio: { type: "api", key: "studio-stored-key" },
      openai: { type: "api", key: "openai-secret" },
    }
    try {
      const backend = await run(resolveEffect(), {
        config: {
          image_generation: { provider: "studio", model: "paint-v1", auth: "api" },
          provider: { studio: { options: { baseURL: new URL("v1", server.url).toString() } } },
        },
        auth: () => auths,
      })

      expect(backend).toMatchObject({ provider: "studio", model: "paint-v1" })
      const result = await backend.generate({ prompt: "a cat", signal: new AbortController().signal })
      expect(result.mime).toBe("image/png")
      expect(new Uint8Array(result.bytes)).toEqual(PNG)
      expect(requests).toEqual([
        {
          path: "/v1/images/generations",
          authorization: "Bearer studio-stored-key",
          body: { model: "paint-v1", prompt: "a cat" },
        },
      ])

      // 解析后凭据被换成 OAuth：必须 fail closed，不能再发请求。
      auths.studio = { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 }
      await expect(
        backend.generate({ prompt: "again", signal: new AbortController().signal }),
      ).rejects.toThrow(/no longer an API key/)
      expect(requests).toHaveLength(1)
    } finally {
      server.stop(true)
    }
  })

  test("a third-party image provider keeps its own id and passes namespace/slash model ids through unchanged", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = serve(async (request) => {
      bodies.push((await request.json()) as Record<string, unknown>)
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    try {
      const config = {
        image_generation: { provider: "acme-images", model: "acme/v2/paint", auth: "api" as const },
        provider: { "acme-images": { api: new URL("v1", server.url).toString(), options: { apiKey: "acme-key" } } },
      }
      const auths: Record<string, Auth.Info> = {
        openai: { type: "api", key: "openai-secret" },
      }

      const declared = await run(resolveEffect(), { config, auth: () => auths })
      expect(declared).toMatchObject({ provider: "acme-images", model: "acme/v2/paint" })

      const requested = await run(resolveEffect("acme/other-model"), { config, auth: () => auths })
      expect(requested).toMatchObject({ provider: "acme-images", model: "acme/other-model" })
      await requested.generate({ prompt: "a hat", signal: new AbortController().signal })

      expect(bodies).toEqual([{ model: "acme/other-model", prompt: "a hat" }])
    } finally {
      server.stop(true)
    }
  })

  test("API credentials fall back to the selected provider's own env var", async () => {
    const requests: (string | null)[] = []
    const server = serve((request) => {
      requests.push(request.headers.get("authorization"))
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    const previous = process.env.REDCODE_IMAGE_BACKEND_TEST_KEY
    process.env.REDCODE_IMAGE_BACKEND_TEST_KEY = "studio-env-key"
    try {
      const backend = await run(resolveEffect(), {
        config: {
          image_generation: { provider: "studio", model: "paint", auth: "api" },
          provider: {
            studio: {
              env: ["REDCODE_IMAGE_BACKEND_TEST_KEY"],
              options: { baseURL: new URL("v1", server.url).toString() },
            },
          },
        },
        auth: () => ({ openai: { type: "api", key: "openai-secret" } }),
      })
      await backend.generate({ prompt: "cat", signal: new AbortController().signal })
      expect(requests).toEqual(["Bearer studio-env-key"])
    } finally {
      if (previous === undefined) delete process.env.REDCODE_IMAGE_BACKEND_TEST_KEY
      else process.env.REDCODE_IMAGE_BACKEND_TEST_KEY = previous
      server.stop(true)
    }
  })

  test("auto-selects the only logged-in OAuth image plugin and its declared default model", async () => {
    const calls: { model: string; type: string }[] = []
    let auths: Record<string, Auth.Info> = { virtual: OAUTH }
    const plugin = imagePlugin("virtual", {
      defaultModel: "virtual/image-1",
      generate: async (input, getAuth) => {
        const auth = await getAuth()
        calls.push({ model: input.model, type: auth.type })
        return { bytes: PNG, mime: "image/png" }
      },
    })

    const backend = await run(resolveEffect(), { config: {}, plugins: [plugin], auth: () => auths })
    expect(backend).toMatchObject({ provider: "virtual", model: "virtual/image-1" })
    await backend.generate({ prompt: "cat", signal: new AbortController().signal })
    expect(calls).toEqual([{ model: "virtual/image-1", type: "oauth" }])

    // 运行中 auth 从 OAuth 改成 API key：插件只能拿到 oauth，必须拒绝而不是拿到别的 key。
    auths = { virtual: { type: "api", key: "swapped-key" } }
    await expect(
      backend.generate({ prompt: "again", signal: new AbortController().signal }),
    ).rejects.toThrow(/no longer logged in with OAuth/)
    expect(calls).toHaveLength(1)
  })

  test("reports a clear error when no eligible OAuth image backend exists", async () => {
    await expect(run(resolveEffect(), { config: {} })).rejects.toThrow(/No image generation backend is available/)
    await expect(
      run(resolveEffect(), {
        config: {},
        plugins: [imagePlugin("virtual")],
        auth: () => ({ virtual: { type: "api", key: "not-oauth" } }),
      }),
    ).rejects.toThrow(/No image generation backend is available/)
    await expect(
      run(resolveEffect(), {
        config: { disabled_providers: ["virtual"] },
        plugins: [imagePlugin("virtual")],
        auth: () => ({ virtual: OAUTH }),
      }),
    ).rejects.toThrow(/No image generation backend is available/)
  })

  test("refuses to pick automatically when multiple logged-in OAuth image providers exist", async () => {
    await expect(
      run(resolveEffect(), {
        config: {},
        plugins: [imagePlugin("provider-a"), imagePlugin("provider-b")],
        auth: () => ({ "provider-a": OAUTH, "provider-b": OAUTH }),
      }),
    ).rejects.toThrow(/Multiple OAuth image providers are available \(provider-a, provider-b\)/)
  })

  test("explicit OAuth uses the configured plugin and model; a per-call model only replaces the wire model", async () => {
    const calls: string[] = []
    const plugin = imagePlugin("virtual", {
      defaultModel: "default-image",
      generate: async (input) => {
        calls.push(input.model)
        return { bytes: PNG, mime: "image/png" }
      },
    })
    const auths = { virtual: OAUTH }
    const config = { image_generation: { provider: "virtual", model: "configured-image", auth: "oauth" as const } }

    const backend = await run(resolveEffect(), {
      config,
      plugins: [{ auth: { provider: "virtual", methods: [] } }, plugin],
      auth: () => auths,
    })
    expect(backend).toMatchObject({ provider: "virtual", model: "configured-image" })
    await backend.generate({ prompt: "cat", signal: new AbortController().signal })

    const overridden = await run(resolveEffect("requested/model"), { config, plugins: [plugin], auth: () => auths })
    expect(overridden).toMatchObject({ provider: "virtual", model: "requested/model" })
    await overridden.generate({ prompt: "cat", signal: new AbortController().signal })

    expect(calls).toEqual(["configured-image", "requested/model"])
  })

  test("explicit OAuth requires a plugin that declares image support and an actual OAuth login", async () => {
    await expect(
      run(resolveEffect(), {
        config: { image_generation: { provider: "openai", model: "gpt-image-1", auth: "oauth" } },
        plugins: [{ auth: { provider: "openai", methods: [] } }],
        auth: () => ({ openai: OAUTH }),
      }),
    ).rejects.toThrow(/no installed plugin declares OAuth image support/)

    await expect(
      run(resolveEffect(), {
        config: { image_generation: { provider: "virtual", model: "image-1", auth: "oauth" } },
        plugins: [imagePlugin("virtual")],
        auth: () => ({ virtual: { type: "api", key: "api-key" } }),
      }),
    ).rejects.toThrow(/not logged in with OAuth/)
  })

  test("explicit API auth does not fall back to an existing OAuth subscription", async () => {
    await expect(
      run(resolveEffect(), {
        config: {
          image_generation: { provider: "virtual", model: "image-1", auth: "api" },
          provider: { virtual: { api: "http://127.0.0.1:1/v1" } },
        },
        auth: () => ({ virtual: OAUTH }),
      }),
    ).rejects.toThrow(/logged in with OAuth, but image_generation.auth is "api"/)
  })

  test("official openai credentials never go to a custom site", async () => {
    let requests = 0
    const server = serve(() => {
      requests += 1
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    try {
      await expect(
        run(resolveEffect(), {
          config: {
            image_generation: { provider: "openai", model: "gpt-image-1", auth: "api" },
            provider: { openai: { options: { baseURL: server.url.href, apiKey: "sk-test" } } },
          },
        }),
      ).rejects.toThrow(/non-official endpoint/)
      expect(requests).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("explicit openai + api may omit the address and defaults to the official API", async () => {
    const backend = await run(resolveEffect(), {
      config: { image_generation: { provider: "openai", model: "gpt-image-1", auth: "api" } },
      auth: () => ({ openai: { type: "api", key: "sk-test" } }),
    })
    expect(backend).toMatchObject({ provider: "openai", model: "gpt-image-1" })
    // 不调用 generate：官方地址在测试里不应产生真实外网请求。
  })

  test("non-OpenAI API providers must declare an endpoint", async () => {
    await expect(
      run(resolveEffect(), {
        config: {
          image_generation: { provider: "studio", model: "paint", auth: "api" },
          provider: { studio: { options: { apiKey: "studio-key" } } },
        },
      }),
    ).rejects.toThrow(/no base URL is set/)
  })
})
