import { closeSync, openSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import { windowsCommand } from "../../util/windows-command"

// 261126 Red Windows 后台作业的控制台边界：node:child_process 的 detached 在 Bun
// 1.3.14 下会把 fd 重定向一起丢掉（实测日志 0 字节），不 detached 又让 shell 继承
// 宿主控制台，孙进程写 CONOUT$ 会直接刷进 TUI。这里自己 CreateProcessW：
// CREATE_NO_WINDOW 给目标一个独立的隐藏控制台，stdout/stderr 仍继承本作业的 log fd。
// 实测 CREATE_NO_WINDOW 子进程有控制台（CONOUT$ 可打开）但不连宿主 PTY；stdout/stderr
// 与退出码都正常。std handles 与 env block 的传法沿用 windows-job-runner（已生产
// 验证），但这里刻意不建 Job Object，宿主退出后作业必须继续存活。
// 决策记录：docs/notes/implemented/bug-fix/2026-11-26-windows-background-console.md
const CREATE_NO_WINDOW = 0x08000000
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const CREATE_UNICODE_ENVIRONMENT = 0x400
const STARTF_USESTDHANDLES = 0x100
const HANDLE_FLAG_INHERIT = 1
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 258
const INVALID_HANDLE_VALUE = -1
const INVALID_FILE_DESCRIPTOR = -2

type Options = {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  statusPath: string
  onExit?: (code: number | null) => void
  onError: (error: unknown) => void
}

function wide(value: string) {
  return Buffer.from(value + "\0", "utf16le")
}

function environment(env: NodeJS.ProcessEnv) {
  return Buffer.from(
    `${Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.toUpperCase().localeCompare(right.toUpperCase()))
      .map(([key, value]) => `${key}=${value}`)
      .join("\0")}\0\0`,
    "utf16le",
  )
}

async function native() {
  // 261126 Red bun:ffi 必须惰性加载：GUI sidecar 是 Node bundle，静态 import 会被
  //   Bun.build 提升到 node.js 顶层，Electron 的 ESM loader 不认 bun: 协议，
  //   sidecar 启动即死。动态 import + build-node 的 external 保证只在 Bun 运行时求值。
  const { dlopen, ptr } = await import("bun:ffi")
  const kernel32 = dlopen("kernel32.dll", {
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
    SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "i32" },
    UpdateProcThreadAttribute: {
      args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"],
      returns: "i32",
    },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  })
  const current = dlopen(process.execPath, {
    uv_get_osfhandle: { args: ["i32"], returns: "ptr" },
  })
  return {
    createProcessW: kernel32.symbols.CreateProcessW,
    deleteProcThreadAttributeList: kernel32.symbols.DeleteProcThreadAttributeList,
    getExitCodeProcess: kernel32.symbols.GetExitCodeProcess,
    getLastError: kernel32.symbols.GetLastError,
    initializeProcThreadAttributeList: kernel32.symbols.InitializeProcThreadAttributeList,
    setHandleInformation: kernel32.symbols.SetHandleInformation,
    updateProcThreadAttribute: kernel32.symbols.UpdateProcThreadAttribute,
    waitForSingleObject: kernel32.symbols.WaitForSingleObject,
    closeHandle: kernel32.symbols.CloseHandle,
    uvGetOsfhandle: current.symbols.uv_get_osfhandle,
    ptr,
  }
}

// 261126 Red bindings 只解析一次：每次后台命令重新 dlopen 会重复分配 FFI trampoline。
type API = Awaited<ReturnType<typeof native>>
type Handle = NonNullable<ReturnType<API["uvGetOsfhandle"]>>
let bindings: Promise<API> | undefined

export async function spawnWindowsBackground(options: Options) {
  const api = await (bindings ??= native())
  const env = Object.fromEntries(
    Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  // windowsCommand 复用 cross-spawn 的 PATH/引号/`.cmd` 解析：目标收到的 argv 与
  // 直接 spawn 一致，用户命令不会被额外一层 shell 重解析。
  const invocation = windowsCommand(options.file, options.args, { cwd: options.cwd, env })
  // 261124 Red Git Bash 继承 O_APPEND 句柄会丢输出；后台日志统一用截断写。
  const output = openSync(options.logPath, "w")
  let input: number | undefined
  let processHandle: Handle | undefined
  try {
    input = openSync(os.devNull, "r")
    const carriers = [input, output, output].map((fd) => api.uvGetOsfhandle(fd))
    if (
      carriers.some(
        (handle) =>
          handle === null || handle === 0 || handle === INVALID_HANDLE_VALUE || handle === INVALID_FILE_DESCRIPTOR,
      )
    )
      throw new Error("Failed to resolve background stdio handles")
    const handles = carriers as [Handle, Handle, Handle]
    for (const handle of handles) {
      if (api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) === 0)
        throw new Error(`SetHandleInformation failed (${api.getLastError()})`)
    }
    // 261126 Red bInheritHandles 会带上宿主里所有可继承句柄（多工具宿主并不干净）；
    // 用 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 把继承面钉死在本作业的 stdin 与 log。
    const size = Buffer.alloc(8)
    api.initializeProcThreadAttributeList(null, 1, 0, size)
    const attribute = Buffer.alloc(Number(size.readBigUInt64LE(0)))
    let initialized = false
    try {
      if (api.initializeProcThreadAttributeList(attribute, 1, 0, size) === 0)
        throw new Error(`InitializeProcThreadAttributeList failed (${api.getLastError()})`)
      initialized = true
      const list = Buffer.alloc(new Set(handles).size * 8)
      let offset = 0
      for (const handle of new Set(handles)) {
        list.writeBigUInt64LE(BigInt(handle), offset)
        offset += 8
      }
      if (
        api.updateProcThreadAttribute(
          attribute,
          0,
          PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          list,
          list.length,
          null,
          null,
        ) === 0
      )
        throw new Error(`UpdateProcThreadAttribute failed (${api.getLastError()})`)
      // STARTUPINFOEXW = STARTUPINFOW (104 bytes) + lpAttributeList。
      const startup = Buffer.alloc(112)
      startup.writeUInt32LE(startup.length, 0)
      startup.writeUInt32LE(STARTF_USESTDHANDLES, 60)
      handles.forEach((handle, index) => startup.writeBigUInt64LE(BigInt(handle), 80 + index * 8))
      startup.writeBigUInt64LE(BigInt(api.ptr(attribute)), 104)
      const information = Buffer.alloc(24)
      const created = api.createProcessW(
        wide(invocation.executable),
        wide(invocation.commandLine),
        null,
        null,
        1,
        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
        environment(options.env),
        wide(options.cwd),
        startup,
        information,
      )
      if (created === 0) throw new Error(`CreateProcessW failed (${api.getLastError()})`)
      const target = Number(information.readBigUInt64LE(0)) as unknown as Handle
      processHandle = target
      const pid = information.readUInt32LE(16)
      api.closeHandle(Number(information.readBigUInt64LE(8)) as unknown as Handle)
      const code = Buffer.alloc(4)
      // 工具调用必须立即返回；退出由已 unref 的轮询收口。宿主先退出时进程句柄随进程
      // 释放，作业本身（未入 Job）继续跑，status 缺失即「未记录」。
      const timer = setInterval(() => {
        const waited = api.waitForSingleObject(target, 0)
        if (waited === WAIT_TIMEOUT) return
        clearInterval(timer)
        if (waited !== WAIT_OBJECT_0) {
          options.onExit?.(null)
          options.onError(new Error(`WaitForSingleObject failed (${api.getLastError()})`))
          api.closeHandle(target)
          return
        }
        if (api.getExitCodeProcess(target, code) === 0) {
          options.onExit?.(null)
          options.onError(new Error(`GetExitCodeProcess failed (${api.getLastError()})`))
          api.closeHandle(target)
          return
        }
        const exitCode = code.readUInt32LE(0)
        options.onExit?.(exitCode)
        try {
          const partial = `${options.statusPath}.tmp`
          writeFileSync(partial, `exit ${exitCode}\n`)
          renameSync(partial, options.statusPath)
        } catch (error) {
          options.onError(error)
        } finally {
          api.closeHandle(target)
        }
      }, 200)
      timer.unref()
      return pid
    } finally {
      for (const handle of handles) api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)
      if (initialized) api.deleteProcThreadAttributeList(attribute)
    }
  } catch (error) {
    if (processHandle !== undefined) api.closeHandle(processHandle)
    throw error
  } finally {
    if (input !== undefined) closeSync(input)
    closeSync(output)
  }
}
