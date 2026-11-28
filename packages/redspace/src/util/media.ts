const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

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
function completeJpeg(bytes: Uint8Array) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  const last = bytes.byteLength - 1
  if (bytes[last - 1] !== 0xff || bytes[last] !== 0xd9) return false
  let offset = 2
  let frame = false
  while (offset + 2 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false
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
    if (marker === 0xd9) return false
    if (offset + 4 > bytes.byteLength) return false
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2 || offset + 2 + length > bytes.byteLength) return false
    if (marker === 0xda) return frame && length >= 6
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) frame = true
    offset += 2 + length
  }
  return false
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
