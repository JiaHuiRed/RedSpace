// 261126 Red Windows 控制台串屏回归的 test fixture：在独立 PTY 里扮演 RedSpace 宿主，
// 用真实后台启动路径 spawn 一个会直写 CONOUT$ 的孙进程。positive control 用旧的
// nodeSpawn 参数，证明这套 PTY 观测能抓到串屏；real 走生产用的 helper。
import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import { spawnWindowsBackground } from "../../src/tool/shell/background"

const argv = process.argv.slice(2)

if (argv[0] === "child") {
  const marker = argv[1]
  fs.writeSync(1, "PROBE_STDOUT\n")
  fs.writeSync(2, "PROBE_STDERR\n")
  const console = fs.openSync("CONOUT$", "w")
  fs.writeSync(console, `${marker}\n`)
  fs.closeSync(console)
  process.exit(0)
}

const [mode, shell, logPath, statusPath, donePath, marker, tracePath] = argv
// 261127 Red runner-only 的 0xC000013A 需要判层：宿主每步先落盘，再看 PTY 报告的是
//   哪一层退出；trace 缺失=没活到 boot，有 boot 无 launched=死在本机启动段。
const stage = (text: string) => {
  if (!tracePath) return
  fs.appendFileSync(tracePath, `${new Date().toISOString()} ${text}\n`)
}
stage(`boot mode=${mode} pid=${process.pid} tty=${process.stdout.isTTY}`)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const prefix = `& ${quote(process.execPath)} ${quote(process.argv[1])} child`
const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${prefix} ${quote(marker)}`]
const donePartial = `${donePath}.tmp`
// 261127 Red Set-Content 直接写 done 会被轮询读到半截空串（实测 CI/并行下偶发）：
//   先写同目录临时文件再原子改名，读者只可能 ENOENT 或读到完整内容。
const orphan = `Start-Sleep -Milliseconds 1500; Set-Content -LiteralPath ${quote(donePartial)} -Value done; [System.IO.File]::Move(${quote(donePartial)}, ${quote(donePath)})`
const waitForStatus = () =>
  new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(statusPath)) return
      clearInterval(timer)
      resolve()
    }, 50)
  })

const legacy = () => {
  const fd = fs.openSync(logPath, "w")
  const child = nodeSpawn(shell, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", fd, fd], windowsHide: true })
  fs.closeSync(fd)
  child.once("exit", (code) => {
    const partial = `${statusPath}.tmp`
    fs.writeFileSync(partial, `exit ${code ?? 1}\n`)
    fs.renameSync(partial, statusPath)
  })
  return child
}

if (mode === "orphan") {
  // 261126 Red spawnWindowsBackground 惰性加载 bun:ffi，必须先等进程真正起好再 exit —
  //   否则「宿主退出后作业存活」测的是宿主退出前作业没起。
  stage("spawn orphan background shell")
  const pid = await spawnWindowsBackground({
    file: shell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", orphan],
    cwd: process.cwd(),
    env: process.env,
    logPath,
    statusPath,
    onError: (error) => fs.writeSync(2, `fixture error: ${String(error)}\n`),
  })
  stage(`launched pid=${pid}`)
  stage("exit 0")
  process.exit(0)
}

if (mode === "legacy") {
  stage("spawn legacy shell")
  const child = legacy()
  stage(`launched pid=${child.pid ?? "<none>"}`)
} else {
  stage("spawn background shell")
  const pid = await spawnWindowsBackground({
    file: shell,
    args,
    cwd: process.cwd(),
    env: process.env,
    logPath,
    statusPath,
    onError: (error) => fs.writeSync(2, `fixture error: ${String(error)}\n`),
  })
  stage(`launched pid=${pid}`)
}

await waitForStatus()
stage(`status ${fs.readFileSync(statusPath, "utf8").trim()}`)
stage("exit 0")
process.exit(0)
