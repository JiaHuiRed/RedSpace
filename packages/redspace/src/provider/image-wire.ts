import { randomUUID } from "node:crypto"
import type { ImageGenerationInput, ImageGenerationSource } from "@redcode-ai/plugin"
import { completeImageMime } from "@/util/media"

// 261127 Karina image wire: OpenAI Images-compatible 生图/改图的线协议层。
//
// 只负责请求形状、响应解析与边界检查；provider 选择、凭据、落盘都由调用方处理。
// 两类后端共用同一套响应解析（data[0].b64_json 或原始图片字节）：
// - openai: 标准 /v1/images/generations + /v1/images/edits（multipart）。
//   native gpt-image-1 不接受 response_format，所以这一层任何情况都不发它；
//   兼容第三方返回 b64_json 时照常解析，返回 URL 则明确拒绝（不跟外部 URL）。
// - codex: ChatGPT 订阅后端的 JSON codec，实测字段见 buildBody。
//
// 安全边界：不跟随重定向、不重试、不切后端；响应体流式读取并设字节上限；
// 错误信息不回显请求 URL、凭据或原始 base64。

const PREFIX = "image wire: "

/** 单张解码后图片上限；与 GUI 原图预览上限一致（packages/app/src/context/file/content-cache.ts）。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 线协议响应体上限：MAX_IMAGE_BYTES 经 base64 膨胀约 4/3 后仍需容纳 JSON 外壳。 */
export const MAX_RESPONSE_BYTES = 28 * 1024 * 1024

export type ImageMime = "image/png" | "image/jpeg" | "image/webp"
export type ImageProtocol = "openai" | "codex"

export type ImageSource = ImageGenerationSource

export type RequestImageInput = ImageGenerationInput & {
  baseURL: string
  protocol: ImageProtocol
  fetch: (url: URL, init: RequestInit) => Promise<Response>
  headers?: HeadersInit
}

export interface ImageResult {
  bytes: Uint8Array
  mime: ImageMime
}

export async function requestImage(input: RequestImageInput): Promise<ImageResult> {
  const headers = new Headers(input.headers)
  const response = await input.fetch(endpoint(input.baseURL, input.source ? "images/edits" : "images/generations"), {
    method: "POST",
    headers,
    body: buildBody(input, headers),
    signal: input.signal,
    redirect: "manual",
  })

  if (response.status === 0) {
    await cancelBody(response)
    throw new Error(`${PREFIX}opaque redirect was not followed`)
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelBody(response)
    throw new Error(`${PREFIX}redirect (HTTP ${response.status}) was not followed`)
  }
  if (!response.ok) {
    await cancelBody(response)
    throw new Error(errorFromStatus(response.status))
  }

  return decodeImage(response, await readBounded(response))
}

function endpoint(baseURL: string, path: string) {
  if (!URL.canParse(baseURL)) throw new Error(`${PREFIX}invalid base URL`)
  const url = new URL(baseURL)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error(`${PREFIX}expected an HTTP(S) base URL without embedded credentials`)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`
  return url
}

function buildBody(input: RequestImageInput, headers: Headers): BodyInit {
  // codex 每次生图/改图带一个随机 turn id；本层一次只产一张，跨调用没有共享 turn 概念
  if (input.protocol === "codex") headers.set("x-codex-image-turn-id", randomUUID())

  if (input.source && input.protocol === "openai") {
    // 交给 fetch 生成 multipart boundary，调用方给的 Content-Type 会破坏 boundary
    headers.delete("content-type")
    const form = new FormData()
    form.set("model", input.model)
    form.set("prompt", input.prompt)
    if (input.size) form.set("size", input.size)
    if (input.background) form.set("background", input.background)
    if (input.output_format) form.set("output_format", input.output_format)
    form.set(
      "image",
      new Blob([new Uint8Array(input.source.bytes).buffer], { type: input.source.mime }),
      input.source.filename,
    )
    return form
  }

  headers.set("content-type", "application/json")
  if (input.protocol === "openai")
    return JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      ...(input.size ? { size: input.size } : {}),
      ...(input.background ? { background: input.background } : {}),
      ...(input.output_format ? { output_format: input.output_format } : {}),
    })

  // codex 线协议只确认了 background 字段本身（默认 auto，调用方可覆盖）；
  // output_format 没有已证实的 Codex 字段，这里不发，需要的格式由成品层转码。
  return JSON.stringify({
    model: input.model,
    prompt: input.prompt,
    size: input.size ?? "auto",
    ...(input.source
      ? {
          images: [
            {
              image_url: `data:${input.source.mime};base64,${Buffer.from(input.source.bytes).toString("base64")}`,
            },
          ],
        }
      : {}),
    quality: "auto",
    background: input.background ?? "auto",
  })
}

async function readBounded(response: Response) {
  const declared = response.headers.get("content-length")
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    await cancelBody(response)
    throw new Error(`${PREFIX}response body exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {}) // 已经按上限失败，取消流的错误没有额外信息
      throw new Error(`${PREFIX}response body exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }

  return concat(chunks, total)
}

function concat(chunks: Uint8Array[], length: number) {
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decodeImage(response: Response, body: Uint8Array): ImageResult {
  const declared = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()

  if (declared.startsWith("image/")) {
    if (body.byteLength > MAX_IMAGE_BYTES) throw new Error(`${PREFIX}image exceeds ${MAX_IMAGE_BYTES} bytes`)
    const mime = completeImageMime(body)
    if (!mime)
      throw new Error(`${PREFIX}response declared ${declared} but payload is not a complete PNG/JPEG/WebP image`)
    if (mime !== declared) throw new Error(`${PREFIX}response declared ${declared} but payload is ${mime}`)
    return { bytes: body, mime }
  }

  if (declared.includes("json") || firstByte(body) === 0x7b) return decodeJson(body)

  if (body.byteLength > MAX_IMAGE_BYTES) throw new Error(`${PREFIX}image exceeds ${MAX_IMAGE_BYTES} bytes`)
  const mime = completeImageMime(body)
  if (mime) return { bytes: body, mime }
  throw new Error(`${PREFIX}response is not a complete PNG/JPEG/WebP image (content-type: ${declared || "missing"})`)
}

function decodeJson(body: Uint8Array): ImageResult {
  const parsed = tryJson(new TextDecoder().decode(body))
  if (parsed === undefined) throw new Error(`${PREFIX}response is not valid JSON`)

  const data = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : []
  const first = isRecord(data[0]) ? data[0] : undefined

  if (first && typeof first.b64_json === "string" && first.b64_json.length > 0) {
    const bytes = Buffer.from(first.b64_json, "base64")
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${PREFIX}image exceeds ${MAX_IMAGE_BYTES} bytes`)
    const mime = completeImageMime(bytes)
    if (!mime)
      throw new Error(`${PREFIX}response data[0].b64_json did not decode to a complete PNG/JPEG/WebP image`)
    return { bytes, mime }
  }

  if (first && typeof first.url === "string")
    throw new Error(`${PREFIX}response returned a URL instead of inline image data; URL fetching is disabled`)

  throw new Error(`${PREFIX}response contained no image data (expected data[0].b64_json)`)
}

const STATUS_HINTS: Record<number, string> = {
  400: "request rejected by the provider",
  401: "authentication failed; check the provider credentials",
  402: "quota or billing limit reached",
  403: "access denied by the provider",
  404: "endpoint or model not found",
  408: "provider timed out",
  409: "provider reported a conflict",
  413: "request too large",
  422: "request rejected by the provider",
  429: "rate limited or quota exceeded",
  500: "provider failed to process the request",
  502: "provider is temporarily unavailable",
  503: "provider is temporarily unavailable",
  504: "provider timed out",
}

function errorFromStatus(status: number) {
  const hint =
    STATUS_HINTS[status] ??
    (status >= 500 ? "provider failed to process the request" : "request rejected by the provider")
  return `${PREFIX}HTTP ${status}: ${hint}`
}

async function cancelBody(response: Response) {
  if (!response.body) return
  await response.body.cancel().catch(() => {}) // 已经按状态/上限失败，取消流的错误没有额外信息
}

function firstByte(bytes: Uint8Array) {
  return bytes.find((byte) => byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09)
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined // 错误体可能是 HTML/纯文本，解析失败按未知 code 处理
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ImageWire from "./image-wire"
