import { describe, expect, test } from "bun:test"
import {
  MAX_IMAGE_BYTES,
  MAX_RESPONSE_BYTES,
  requestImage,
  type ImageSource,
  type RequestImageInput,
} from "@/provider/image-wire"

const unbase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"))
// 真实可解码的 1×1 图片；结构完整的截断头（旧的 12 字节常量）本身就是本文件的回归对象。
const PNG = unbase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
)
const JPEG = unbase64(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAEAAQMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=",
)
const WEBP = unbase64("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const source: ImageSource = { bytes: PNG, mime: "image/png", filename: "cat.png" }

function b64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64")
}

function serve(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({ port: 0, fetch: (request) => handler(request, new URL(request.url)) })
}

function input(server: ReturnType<typeof Bun.serve>, overrides: Partial<RequestImageInput> = {}): RequestImageInput {
  return {
    baseURL: new URL("v1", server.url).toString(),
    protocol: "openai",
    fetch: (url, init) => fetch(url, init),
    model: "gpt-image-1",
    prompt: "a cat",
    signal: new AbortController().signal,
    ...overrides,
  }
}

function cancellation() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, cancel: () => resolve() }
}

function monitor(response: Response) {
  const state = { read: 0, cancelled: false }
  if (!response.body) return { response, state }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) return controller.close()
      state.read += value.byteLength
      controller.enqueue(value)
    },
    async cancel(reason) {
      state.cancelled = true
      await reader.cancel(reason)
    },
  })
  return { response: new Response(body, { status: response.status, headers: response.headers }), state }
}

async function expectCancelled(promise: Promise<void>) {
  await Promise.race([
    promise,
    Bun.sleep(2000).then(() => {
      throw new Error("response body was not cancelled")
    }),
  ])
}

function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected requestImage to reject")
    },
    (cause) => cause as Error,
  )
}

describe("provider.image-wire", () => {
  test("rejects non-HTTP endpoints and embedded credentials before dispatch", async () => {
    let calls = 0
    for (const baseURL of ["file:///images", "https://name:secret@example.test/v1"]) {
      await expect(requestImage({
        baseURL, protocol: "openai", model: "art", prompt: "cat", signal: new AbortController().signal,
        fetch: async () => { calls++; return new Response() },
      })).rejects.toThrow("HTTP(S) base URL without embedded credentials")
    }
    expect(calls).toBe(0)
  })

  test("openai generate: JSON without response_format, b64_json response", async () => {
    let seen: { path: string; headers: Headers; body: Record<string, unknown> } | undefined
    const server = serve(async (request, url) => {
      seen = { path: url.pathname, headers: request.headers, body: await request.json() }
      return Response.json({ created: 1, data: [{ b64_json: b64(PNG) }] })
    })
    try {
      const controller = new AbortController()
      const inits: RequestInit[] = []
      const result = await requestImage(
        input(server, {
          headers: { authorization: "Bearer test-key" },
          size: "1024x1024",
          signal: controller.signal,
          fetch: (url, init) => {
            inits.push(init)
            return fetch(url, init)
          },
        }),
      )

      expect(seen?.path).toBe("/v1/images/generations")
      expect(seen?.headers.get("authorization")).toBe("Bearer test-key")
      expect(seen?.headers.get("content-type")).toContain("application/json")
      expect(seen?.body).toEqual({ model: "gpt-image-1", prompt: "a cat", size: "1024x1024" })
      expect("response_format" in (seen?.body ?? {})).toBe(false)
      expect(inits[0]?.redirect).toBe("manual")
      expect(inits[0]?.signal).toBe(controller.signal)
      expect(result.mime).toBe("image/png")
      expect(new Uint8Array(result.bytes)).toEqual(PNG)
    } finally {
      server.stop(true)
    }
  })

  test("openai edit: multipart with source image", async () => {
    let path = ""
    let contentType = ""
    let form: FormData | undefined
    const server = serve(async (request, url) => {
      path = url.pathname
      contentType = request.headers.get("content-type") ?? ""
      form = await request.formData()
      return Response.json({ data: [{ b64_json: b64(JPEG) }] })
    })
    try {
      // Buffer.slice() 是视图；用带前后缀的 Buffer 视图验证 multipart 只上传视图范围内的 PNG
      const padded = Buffer.concat([Buffer.from("prefix"), Buffer.from(PNG), Buffer.from("suffix")])
      const paddedSource: ImageSource = {
        bytes: padded.subarray(6, 6 + PNG.length),
        mime: "image/png",
        filename: "cat.png",
      }
      const result = await requestImage(
        input(server, {
          prompt: "add a hat",
          size: "1024x1024",
          background: "opaque",
          output_format: "jpeg",
          source: paddedSource,
        }),
      )

      expect(path).toBe("/v1/images/edits")
      expect(contentType.startsWith("multipart/form-data; boundary=")).toBe(true)
      expect(form?.get("model")).toBe("gpt-image-1")
      expect(form?.get("prompt")).toBe("add a hat")
      expect(form?.get("size")).toBe("1024x1024")
      expect(form?.get("background")).toBe("opaque")
      expect(form?.get("output_format")).toBe("jpeg")
      const file = form?.get("image")
      expect(file).toBeInstanceOf(File)
      expect((file as File).name).toBe("cat.png")
      expect((file as File).type).toBe("image/png")
      expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(PNG)
      expect(result.mime).toBe("image/jpeg")
      expect(new Uint8Array(result.bytes)).toEqual(JPEG)
    } finally {
      server.stop(true)
    }
  })

  test("codex generate: auto quality/background/size and a random turn id per call", async () => {
    const turnIds: string[] = []
    const bodies: Record<string, unknown>[] = []
    const server = serve(async (request) => {
      turnIds.push(request.headers.get("x-codex-image-turn-id") ?? "")
      bodies.push(await request.json())
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    try {
      const first = await requestImage(input(server, { protocol: "codex", model: "gpt-5-codex", size: "1024x1024" }))
      const second = await requestImage(input(server, { protocol: "codex", model: "gpt-5-codex" }))

      expect(first.mime).toBe("image/png")
      expect(second.mime).toBe("image/png")
      expect(bodies[0]).toEqual({
        model: "gpt-5-codex",
        prompt: "a cat",
        size: "1024x1024",
        quality: "auto",
        background: "auto",
      })
      expect(bodies[1]).toEqual({
        model: "gpt-5-codex",
        prompt: "a cat",
        size: "auto",
        quality: "auto",
        background: "auto",
      })
      expect(turnIds[0]).toMatch(UUID)
      expect(turnIds[1]).toMatch(UUID)
      expect(turnIds[0]).not.toBe(turnIds[1])
    } finally {
      server.stop(true)
    }
  })

  test("codex edit: JSON data URL with turn id and default size", async () => {
    let path = ""
    let turnId = ""
    let body: Record<string, unknown> | undefined
    const server = serve(async (request, url) => {
      path = url.pathname
      turnId = request.headers.get("x-codex-image-turn-id") ?? ""
      body = await request.json()
      return Response.json({ data: [{ b64_json: b64(WEBP) }] })
    })
    try {
      const result = await requestImage(input(server, { protocol: "codex", prompt: "add a hat", source }))

      expect(path).toBe("/v1/images/edits")
      expect(turnId).toMatch(UUID)
      expect(body).toEqual({
        model: "gpt-image-1",
        prompt: "add a hat",
        size: "auto",
        images: [{ image_url: `data:image/png;base64,${b64(PNG)}` }],
        quality: "auto",
        background: "auto",
      })
      expect(result.mime).toBe("image/webp")
      expect(new Uint8Array(result.bytes)).toEqual(WEBP)
    } finally {
      server.stop(true)
    }
  })

  test("compatible providers may return raw image bytes", async () => {
    const server = serve(() => new Response(WEBP, { headers: { "content-type": "image/webp" } }))
    try {
      const result = await requestImage(input(server))
      expect(result.mime).toBe("image/webp")
      expect(new Uint8Array(result.bytes)).toEqual(WEBP)
    } finally {
      server.stop(true)
    }
  })

  test("non-2xx returns only status and a local hint without echoing provider text", async () => {
    const secret = "sk-live-secret-value"
    const raw = b64(PNG)
    const cases = [
      { status: 401, hint: "authentication failed", json: true },
      { status: 500, hint: "provider failed to process the request", json: false },
    ]

    for (const item of cases) {
      let hits = 0
      let state: { read: number; cancelled: boolean } | undefined
      const server = serve(() => {
        hits += 1
        const leak = `bad prompt ${secret} at https://api.example.com/v1?key=${secret} data:image/png;base64,${raw}`
        return item.json
          ? Response.json({ error: { message: leak } }, { status: item.status })
          : new Response(leak, { status: item.status })
      })
      try {
        const error = await rejection(
          requestImage(
            input(server, {
              headers: { authorization: `Bearer ${secret}` },
              fetch: async (url, init) => {
                const monitored = monitor(await fetch(url, init))
                state = monitored.state
                return monitored.response
              },
            }),
          ),
        )

        expect(error.message.startsWith("image wire: HTTP ")).toBe(true)
        expect(error.message).toContain(`HTTP ${item.status}`)
        expect(error.message).toContain(item.hint)
        for (const leaked of [secret, "api.example.com", raw, "bad prompt"])
          expect(error.message).not.toContain(leaked)
        expect(hits).toBe(1)
        expect(state?.cancelled).toBe(true)
      } finally {
        server.stop(true)
      }
    }
  })

  test("missing image data is rejected", async () => {
    const server = serve(() => Response.json({ data: [] }))
    try {
      await expect(requestImage(input(server))).rejects.toThrow(/contained no image data/)
    } finally {
      server.stop(true)
    }
  })

  test("URL-only response is rejected without fetching the URL", async () => {
    let externalHits = 0
    const external = serve(() => {
      externalHits += 1
      return new Response(PNG, { headers: { "content-type": "image/png" } })
    })
    const server = serve(() => Response.json({ data: [{ url: new URL("image.png", external.url).toString() }] }))
    try {
      await expect(requestImage(input(server))).rejects.toThrow(/URL fetching is disabled/)
      expect(externalHits).toBe(0)
    } finally {
      server.stop(true)
      external.stop(true)
    }
  })

  test("redirects are not followed and the body is cancelled", async () => {
    let targetHits = 0
    let state: { read: number; cancelled: boolean } | undefined
    const target = serve(() => {
      targetHits += 1
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    const redirect = serve(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024))
        },
      })
      return new Response(body, {
        status: 302,
        headers: { location: new URL("v1/images/generations", target.url).toString() },
      })
    })
    try {
      await expect(
        requestImage(
          input(redirect, {
            fetch: async (url, init) => {
              const monitored = monitor(await fetch(url, init))
              state = monitored.state
              return monitored.response
            },
          }),
        ),
      ).rejects.toThrow(/redirect \(HTTP 302\) was not followed/)
      expect(targetHits).toBe(0)
      expect(state?.cancelled).toBe(true)
      expect(state?.read).toBeLessThan(64 * 1024)
    } finally {
      redirect.stop(true)
      target.stop(true)
    }
  })

  test("content-length above the cap is rejected before reading", async () => {
    // Bun.serve 会改写固定 body 的 content-length，流式 body 手写该头又会挂住连接；
    // 这里用合成 Response 验证预检本身，其余用例仍走 loopback。
    const cancelled = cancellation()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024))
        },
        cancel: cancelled.cancel,
      }),
      { headers: { "content-type": "image/png", "content-length": String(MAX_RESPONSE_BYTES + 1) } },
    )

    await expect(
      requestImage({
        baseURL: "http://127.0.0.1:1/v1",
        protocol: "openai",
        fetch: () => Promise.resolve(response),
        model: "gpt-image-1",
        prompt: "a cat",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`)
    await expectCancelled(cancelled.promise)
  })

  test("fake image mime is rejected", async () => {
    const server = serve(() => new Response(JPEG, { headers: { "content-type": "image/png" } }))
    try {
      await expect(requestImage(input(server))).rejects.toThrow(/declared image\/png but payload is image\/jpeg/)
    } finally {
      server.stop(true)
    }
  })

  test("b64_json that does not decode to an image is rejected", async () => {
    const server = serve(() =>
      Response.json({ data: [{ b64_json: Buffer.from("<html>not an image</html>").toString("base64") }] }),
    )
    try {
      await expect(requestImage(input(server))).rejects.toThrow(/did not decode to a complete PNG\/JPEG\/WebP image/)
    } finally {
      server.stop(true)
    }
  })

  test("truncated image payloads are rejected", async () => {
    const truncated = PNG.subarray(0, 12)
    const raw = serve(() => new Response(truncated, { headers: { "content-type": "image/png" } }))
    const json = serve(() => Response.json({ data: [{ b64_json: b64(truncated) }] }))
    try {
      await expect(requestImage(input(raw))).rejects.toThrow(/not a complete PNG\/JPEG\/WebP image/)
      await expect(requestImage(input(json))).rejects.toThrow(/did not decode to a complete PNG\/JPEG\/WebP image/)
    } finally {
      raw.stop(true)
      json.stop(true)
    }
  })

  test("streamed response without content-length is capped", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const server = serve(() => {
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_RESPONSE_BYTES) return controller.close()
          sent += chunk.byteLength
          controller.enqueue(chunk)
        },
      })
      return new Response(body, { headers: { "content-type": "image/png" } })
    })
    try {
      await expect(requestImage(input(server))).rejects.toThrow(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`)
    } finally {
      server.stop(true)
    }
  })

  test("decoded image above MAX_IMAGE_BYTES is rejected", async () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1)
    oversized.set(PNG.subarray(0, 8))
    const server = serve(() => new Response(oversized, { headers: { "content-type": "image/png" } }))
    try {
      await expect(requestImage(input(server))).rejects.toThrow(`image exceeds ${MAX_IMAGE_BYTES} bytes`)
    } finally {
      server.stop(true)
    }
  })

  test("forwards the abort signal", async () => {
    const server = serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return Response.json({ data: [{ b64_json: b64(PNG) }] })
    })
    try {
      const controller = new AbortController()
      const pending = requestImage(input(server, { signal: controller.signal }))
      setTimeout(() => controller.abort(), 20)
      const error = await rejection(pending)
      expect(error.name).toBe("AbortError")
    } finally {
      server.stop(true)
    }
  })
})
