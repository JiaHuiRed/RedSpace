# Windows 后台命令不能借用 TUI 的控制台

状态:implemented

## 问题

后台运行 Godot 的渲染检查时，字体枚举错误和游戏启动信息直接盖住了 TUI 输入框。引擎实际写出完成标记并以 0 退出，外围脚本因日志含 `ERROR:` 返回 1。错误文字、作业退出码、模型会话是否失败，是三个独立信号。

在独立 Windows 伪终端中重现了 RedSpace 的缺口：用原后台启动参数跑 `PowerShell → 子进程`，stdout 和 stderr 都正确写入 `output.log`；子进程打开 `CONOUT$` 的另一个标记却直接出现在宿主终端。日志重定向不等于控制台隔离。这个对照证明了泄漏途径，不用于推断某一版 Godot 具体调用了哪个 Win32 API。

## 决策

Windows 的 `background: true` 在创建 shell 时使用 `CREATE_NO_WINDOW`，并显式传入标准输入和日志输出句柄。保留原 shell 参数、工作目录和环境，不给用户的命令额外套一层解释器。宿主在进程退出后原子写入 `status.txt`；宿主先退出则状态仍可能是“未记录”，不能用空日志或缺少状态文件判成功。前台工具、交互式 PTY 和 Unix 后台作业不在这次改动之内。

后台作业的退出事件也回到启动它的那条工具记录。先保存启动结果，再把实际退出码或信号写进同一条记录的 metadata：短命令先退出不会被“已启动”盖掉，长命令不必让会话等到退出。客户端显示这项旁注，不改模型已经收到的工具正文，也不因作业退出而再发起模型请求。宿主先退出时仍不猜结果。

`STARTUPINFOEX` 只放行本作业的两个句柄：标准输入和日志文件。标准输出、标准错误使用同一个日志句柄；三个标准槽位要填满，但允许列表不能把同一句柄放两次（编译夹具曾因重复条目得到 Win32 错误 87）。独立 PTY 覆盖旧路径能串屏、新路径不能，以及宿主先退出后作业仍能完成；单文件编译夹具验证了两路日志和非零退出码 `7`。

这条路径依赖 `bun:ffi`，只适用于 Bun（TUI/CLI）。GUI sidecar 是 Node bundle（`build-node.ts`），没有 `bun` 全局，也没有可被串写的宿主控制台：Windows 后台命令在那里退回 `node:child_process` 的 detached spawn（Node 没有 Bun 1.3.14 的 fd 丢失问题）。`bun:ffi` 必须在 server bundle 里标 external 并保持惰性 `import()`——顶层静态 import 会被内联到 `node.js` 顶部，Electron 的 ESM loader 不认 `bun:` 协议，sidecar 启动即死（261126 实证，见 CHANGELOG `[Unreleased]`）。

## 取舍

- **只用 `windowsHide` 或过滤 `ERROR:`**：前者不能阻止已关联控制台的程序直接写屏，后者既管不到这个输出设备，还会吞掉真正的错误。
- **直接改为 `detached: true`**：同一台机器的 Bun 1.3.14 对照中，终端不再出现标记，但两条标准流都丢了，日志为 0 字节。
- **复用 MCP 的 Windows Job Object**：它要求宿主退出时回收整棵进程树；后台命令恰恰要允许继续执行，不该共用这个生命周期。
