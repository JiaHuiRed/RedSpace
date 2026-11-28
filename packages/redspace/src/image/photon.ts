import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Photon = typeof import("@silvia-odwyer/photon-node")

const globals = globalThis as typeof globalThis & {
  __OPENCODE_PHOTON_WASM_PATH?: string
  __REDCODE_PHOTON_WASM_PATH?: string
}

/**
 * 261128 Red 复用 bun patch 过的 photon-node loader：模块加载时读取 globalThis 里的
 * wasm 路径，编译版才能用 Bun 内嵌的 assets 而不是包目录旁的 __dirname。
 *
 * patch 实际读 __OPENCODE_PHOTON_WASM_PATH；__REDCODE_PHOTON_WASM_PATH 是既有调用方
 * 已经设置的名字，继续写一份，避免改动现有 normalize 的加载行为。
 */
export function loadPhoton(): Promise<Photon> {
  const wasm = path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  globals.__OPENCODE_PHOTON_WASM_PATH = wasm
  globals.__REDCODE_PHOTON_WASM_PATH = wasm
  return import("@silvia-odwyer/photon-node")
}
