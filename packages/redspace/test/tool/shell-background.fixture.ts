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

const [mode, shell, logPath, statusPath, donePath, marker] = argv
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const prefix = `& ${quote(process.execPath)} ${quote(process.argv[1])} child`
const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${prefix} ${quote(marker)}`]
const orphan = `Start-Sleep -Milliseconds 1500; Set-Content -LiteralPath ${quote(donePath)} -Value done`

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
}

if (mode === "orphan") {
  spawnWindowsBackground({
    file: shell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", orphan],
    cwd: process.cwd(),
    env: process.env,
    logPath,
    statusPath,
    onError: (error) => fs.writeSync(2, `fixture error: ${String(error)}\n`),
  })
  process.exit(0)
}

if (mode === "legacy") legacy()
else
  spawnWindowsBackground({
    file: shell,
    args,
    cwd: process.cwd(),
    env: process.env,
    logPath,
    statusPath,
    onError: (error) => fs.writeSync(2, `fixture error: ${String(error)}\n`),
  })

await waitForStatus()
process.exit(0)
