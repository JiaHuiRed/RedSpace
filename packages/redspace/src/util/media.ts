const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

/** 解码前的像素预算；与 Image.normalize 共用同一条 32MP 策略。 */
export const MAX_SOURCE_PIXELS = 32_000_000

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}

export type CompleteImageMime = "image/png" | "image/jpeg" | "image/webp"

/**
 * 261128 Red 魔数只证明「前几个字节像图片」：一个 12 字节的截断 PNG 也能通过
 * `sniffAttachmentMime`，落盘后打开是坏的。这里把容器结构走一遍——PNG 的 chunk 链、
 * JPEG 的 marker 链到 EOI、WebP 的 RIFF 长度与 chunk 边界——只放过结构完整的文件。
 *
 * 刻意不做逐像素解码：那要引入图像库，代价与收益不成比例。结构完整不等于解码成功。
 */
export function completeImageMime(bytes: Uint8Array): CompleteImageMime | undefined {
  if (completePng(bytes)) return "image/png"
  if (completeJpeg(bytes)) return "image/jpeg"
  if (completeWebp(bytes)) return "image/webp"
  return undefined
}

// 两个视图各自按自己的 byteOffset 建 DataView：Buffer 可能是一个更大 ArrayBuffer 的切片。
function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

// PNG：IHDR（宽高非零）→ 至少一个非空 IDAT → 长度为零的 IEND 且正好落在文件末尾。
function completePng(bytes: Uint8Array) {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false
  const view = dataView(bytes)
  let offset = 8
  let header = false
  let pixels = false
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > bytes.byteLength) return false
    const type = ascii(bytes, offset + 4, offset + 8)
    if (!header) {
      if (type !== "IHDR" || length !== 13) return false
      if (view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0) return false
      header = true
    } else if (type === "IDAT" && length > 0) pixels = true
    if (type === "IEND") return pixels && length === 0 && end === bytes.byteLength
    offset = end
  }
  return false
}

// JPEG：SOI 开始、EOI 结束，头部段长度都在界内，且必须见到 SOF 与 SOS。
// SOS 之后的熵编码数据不再解析（要正确处理 0xFF00 填充与 RST）；EOI 在末尾已经兜住了截断。
// 同一次 marker walk 同时给出完整性结论与 SOF 尺寸，避免维护两套同形解析。
function jpegInfo(bytes: Uint8Array) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return
  const last = bytes.byteLength - 1
  if (bytes[last - 1] !== 0xff || bytes[last] !== 0xd9) return
  let offset = 2
  let frame = false
  let size: { width: number; height: number } | undefined
  while (offset + 2 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return
    let marker = bytes[offset + 1]
    // 连续的 0xFF 是 marker 前的合法填充
    while (marker === 0xff && offset + 3 <= bytes.byteLength) {
      offset++
      marker = bytes[offset + 1]
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9) return
    if (offset + 4 > bytes.byteLength) return
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2 || offset + 2 + length > bytes.byteLength) return
    if (marker === 0xda) return frame && length >= 6 ? (size ?? { width: 0, height: 0 }) : undefined
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      frame = true
      if (length >= 7) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6]
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8]
        size = { width, height }
      }
    }
    offset += 2 + length
  }
  return
}

function completeJpeg(bytes: Uint8Array) {
  return jpegInfo(bytes) !== undefined
}

export function pngDimensions(bytes: Uint8Array) {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  )
    return
  const header = dataView(bytes)
  const width = header.getUint32(16, false)
  const height = header.getUint32(20, false)
  if (!width || !height) return
  return { width, height }
}

export interface ImageDimensions {
  readonly width: number
  readonly height: number
  readonly animated: boolean
}

// 解码前只读头部确定像素数。format 由调用方给出（工具已校验容器完整性），这里不重复
// 全量扫描；宽高都为零/缺失时返回 undefined，让调用方拒绝而不是猜。
export function imageDimensions(bytes: Uint8Array, format: CompleteImageMime): ImageDimensions | undefined {
  if (format === "image/webp") {
    const size = webpDimensions(bytes)
    if (!size) return
    return size.animated ? size : size.width && size.height ? { ...size, animated: false } : undefined
  }
  const size = format === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes)
  if (!size || !size.width || !size.height) return
  return { width: size.width, height: size.height, animated: false }
}

function jpegDimensions(bytes: Uint8Array) {
  const info = jpegInfo(bytes)
  return info && info.width && info.height ? info : undefined
}

// WebP：VP8X 画布、VP8 有损帧头、VP8L 无损头都能给出真实像素数。静态 VP8X 的画布
// 必须与实际帧一致，否则不认画布尺寸；带 ANIM/ANMF 或动画 flag 的文件只报告 animated，
// 不把静态首帧当作整张图的验证依据。
function webpDimensions(bytes: Uint8Array) {
  const view = dataView(bytes)
  let offset = 12
  let canvas: { width: number; height: number } | undefined
  let frame: { width: number; height: number } | undefined
  let animated = false
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + size > bytes.byteLength) return
    const type = ascii(bytes, offset, offset + 4)
    if (type === "VP8X" && size >= 10) {
      if (bytes[start] & 0x02) animated = true
      canvas = {
        width: 1 + (bytes[start + 4] | (bytes[start + 5] << 8) | (bytes[start + 6] << 16)),
        height: 1 + (bytes[start + 7] | (bytes[start + 8] << 8) | (bytes[start + 9] << 16)),
      }
    } else if (type === "ANIM" || type === "ANMF") {
      animated = true
    } else if (type === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
      const bits = bytes[start + 1] | (bytes[start + 2] << 8) | (bytes[start + 3] << 16) | (bytes[start + 4] << 24)
      frame = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    } else if (type === "VP8 " && size >= 10) {
      const sync = start + 3
      if (bytes[sync] !== 0x9d || bytes[sync + 1] !== 0x01 || bytes[sync + 2] !== 0x2a) return
      const width = (bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff
      const height = (bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff
      if (width && height) frame = { width, height }
    }
    offset = start + size + (size % 2)
  }
  if (animated) return { width: canvas?.width ?? 0, height: canvas?.height ?? 0, animated: true }
  if (canvas && frame && (canvas.width !== frame.width || canvas.height !== frame.height)) return
  const size = canvas ?? frame
  return size ? { ...size, animated: false } : undefined
}

// WebP：RIFF 长度必须与文件一致，chunk 链完整，且至少有一个图像块（VP8/VP8L/VP8X）。
function completeWebp(bytes: Uint8Array) {
  if (bytes.byteLength < 12) return false
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) || !startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return false
  const view = dataView(bytes)
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return false
  let offset = 12
  let image = false
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return false
    const size = view.getUint32(offset + 4, true)
    const end = offset + 8 + size + (size % 2)
    if (end > bytes.byteLength) return false
    const type = ascii(bytes, offset, offset + 4)
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") image = true
    offset = end
  }
  return image
}
