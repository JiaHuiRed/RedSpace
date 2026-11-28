import { MAX_IMAGE_BYTES, type ImageMime, type ImageResult } from "@/provider/image-wire"
import { MAX_SOURCE_PIXELS, imageDimensions } from "@/util/media"
import type { ImageGenerationInput } from "@redcode-ai/plugin"
import type { PhotonImage } from "@silvia-odwyer/photon-node"
import * as Log from "@redcode-ai/core/util/log"
import { loadPhoton, type Photon } from "./photon"

// 261128 Red 供应商成品进入工具前的最后一层：只在用户点名 background 或 output_format
// 时才碰像素；其余情况逐字节透传。见 docs/notes/implemented/feature/2026-11-27-image-tool.md。

const log = Log.create({ service: "image.generated" })
const JPEG_QUALITY = 90

/**
 * 把供应商返回的成品整理成可落盘的图片。默认不改动任何字节；指定 background 时在
 * 实际交付的字节上验证 alpha，指定 output_format 且与原生格式不同时按原尺寸转码。
 *
 * 错误契约：只抛普通 Error，message 只含固定文案与尺寸数字，不回声字节、base64 或
 * 供应商响应。工具层按 message 生成面向用户的失败提示，并把原始成品另存为 image-original-*。
 */
export async function prepareGeneratedImage(
  result: ImageResult,
  options: Pick<ImageGenerationInput, "background" | "output_format"> = {},
): Promise<ImageResult> {
  const target: ImageMime = options.output_format ? `image/${options.output_format}` : result.mime
  const background = options.background ?? "auto"
  // fast path 在解码前返回：透传和同格式不验背景时，不受解码像素上限影响。
  if (background === "auto" && target === result.mime) return result
  if (background === "transparent" && target === "image/jpeg") throw new Error("JPEG cannot store transparent pixels.")

  const size = imageDimensions(result.bytes, result.mime)
  if (!size) throw new Error("Generated image dimensions could not be read.")
  if (size.animated) throw new Error("Animated WebP images are not supported for this operation.")
  if (size.width * size.height > MAX_SOURCE_PIXELS)
    throw new Error(
      `Generated image is ${size.width}x${size.height}, above the ${MAX_SOURCE_PIXELS}-pixel decode limit.`,
    )

  const photon = await loadPhoton().catch((error) => {
    log.warn("failed to load photon", { error })
    throw new Error("Image processing is unavailable.")
  })
  const bytes = target === result.mime ? result.bytes : transcode(photon, result.bytes, target)
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Converted image exceeds the 20 MiB limit.")
  if (background !== "auto") verifyBackground(photon, bytes, background, target)
  return { mime: target, bytes }
}

function transcode(photon: Photon, bytes: Uint8Array, target: ImageMime) {
  const image = decode(photon, bytes)
  try {
    if (target === "image/png") return image.get_bytes()
    if (target === "image/jpeg") return image.get_bytes_jpeg(JPEG_QUALITY)
    return image.get_bytes_webp()
  } catch (error) {
    log.warn("failed to encode generated image", { target, error })
    throw new Error(`Generated image could not be converted to ${target}.`)
  } finally {
    image.free()
  }
}

function decode(photon: Photon, bytes: Uint8Array): PhotonImage {
  try {
    return photon.PhotonImage.new_from_byteslice(bytes)
  } catch (error) {
    log.warn("failed to decode generated image", { error })
    throw new Error("Generated image could not be decoded.")
  }
}

// 只在最终交付的字节上验证；转码到 WebP 后也重新解码，不信任编码器函数名或文件魔数。
function verifyBackground(photon: Photon, bytes: Uint8Array, background: "opaque" | "transparent", mime: ImageMime) {
  const image = decode(photon, bytes)
  try {
    const pixels = image.get_raw_pixels()
    let transparent = false
    let visible = false
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 255) transparent = true
      if (pixels[index] > 0) visible = true
      if (transparent && visible) break
    }
    if (background === "opaque") {
      if (transparent) throw new Error("Opaque background was requested, but the image has transparent pixels.")
      return
    }
    if (!visible)
      throw new Error(`Transparent background was requested, but every pixel in the final ${mime} is transparent.`)
    if (!transparent)
      throw new Error(`Transparent background was requested, but the final ${mime} has no transparent pixels.`)
  } finally {
    image.free()
  }
}
