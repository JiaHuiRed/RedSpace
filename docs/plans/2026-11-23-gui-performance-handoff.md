# GUI 排查交接：回会话启动屏、压缩误报与历史载荷

基线：Windows 桌面 RedSpace `v0.20.4`（`b5459da6`）。这轮只排查，未改运行代码。接手顺序：**先修回会话的整窗启动屏，再分离压缩受理与终态；性能先减 LSP 诊断载荷，消息区空白单独取证。**

## 1. 回会话的整窗启动屏：已隔离复现

用户消息行在渲染时读取 [版本列表资源](../../packages/app/src/pages/session.tsx#L1922)。`/message-versions` 未返回时，读取挂起到 [应用级 Suspense](../../packages/app/src/app.tsx#L255)，所以一个只影响「上一版／下一版」控件的请求能把顶栏和消息一起换成启动图。旧的 `sessionSync` 已有局部边界，不是这条复现链路。

**复现与验收：**

1. 用 Chromium 打开真实前端，复用 [时间线夹具](../../packages/app/e2e/smoke/session-timeline.fixture.ts) 和 [mock server](../../packages/app/e2e/utils/mock-server.ts)。首次进入目标会话，等真实用户消息行出现。
2. 点 Code 回首页，再点同一会话的链接；不要用 `page.goto()` 模拟回切。对照组让版本接口返回 `[]`；实验组只拦住目标会话的 `/message-versions` 响应。
3. 基线实测整个过程只加载一份 HTML 文档。实验组持有响应约 600 ms 时，`[data-splash-surface]` 可见、顶栏和消息行不可见；放行后消息恢复。它证明了这条路径不需要 Electron 重启，但原事件没有网络跟踪，不能对账到同一次请求。

让版本列表非阻塞加载：响应前不显示版本控件，不能挡住会话；响应后只更新对应会话的控件。保留真正冷启动的屏幕反馈，不要靠移动应用级边界消掉症状。新增回归可放在 [session-timeline.spec.ts](../../packages/app/e2e/smoke/session-timeline.spec.ts)，在 `packages/app` 跑 `bun run test:e2e e2e/smoke/session-timeline.spec.ts --project=chromium`。断言版本请求确实仍在途时，顶栏和已缓存的消息可见，且没有启动图。

## 2. 压缩成功仍报超时：已对上服务端记录

同一会话有两次压缩已提交、等待请求随后中断。最近一次从约 256k 压到 70k：标记创建到压缩提交约 66 秒，约 3 秒后 `POST /summarize` 记为 `interrupted`。阶段日志中排队约 6 秒、模型请求约 59 秒，仅这两项就超过 [SDK 的 60 秒普通请求时限](../../packages/sdk/js/src/v2/client.ts#L62)。

[接口](../../packages/redspace/src/server/routes/instance/httpapi/handlers/session.ts#L465) 创建压缩任务后等待整个 `promptSvc.loop`。与此同时，[成功 toast](../../packages/app/src/pages/layout/notification-toasts.ts#L181) 听 `session.compacted`，而 [上下文占用按钮](../../packages/app/src/components/session-context-usage.tsx#L120) 把请求拒绝直接报成「请求失败」。两条反馈说的是不同的事。

改法：服务端明确确认「已受理」，真实完成或失败走会话状态／事件。检查 [命令入口](../../packages/app/src/pages/session/use-session-commands.tsx#L374) 和现有 SDK 调用者，不悄悄改变同步接口的返回含义。不要延长全局时限，也不要吞掉真正的失败。用受控延迟覆盖成功、服务端失败、取消，以及受理后连接断开；断线不应自动再提交一次。

## 3. 性能首刀：别随每条工具记录传整份 LSP 诊断

对故障会话最近 400 条消息（排除分支弃岛）按 `part.data` 的 UTF-8 字节统计：

| 项目 | 样本体积 |
| --- | ---: |
| 全部分片 | 26.06 MiB |
| `edit` / `write` 的 `state.metadata.diagnostics` | 14.45 MiB（55.4%） |
| `read` 的 `state.attachments` | 6.51 MiB |

[工具](../../packages/redspace/src/tool/edit.ts#L328) 把诊断映射存入 metadata，[GUI](../../packages/ui/src/components/message-part.tsx#L122) 只查本次文件、筛严重级别为错误、取前三条。按这一规则复算，该样本被显示的诊断条目仅 **18.6 KiB**，不含外层 JSON。这是落库体积与显示需求之差，不是已测得的 HTTP 字节或 renderer 内存降幅。

优先在 GUI 消息数据边界投影诊断，保留可见信息，不关 LSP、不改工具文本或公开的完整记录，也不回写历史。检查首拉、分页、重连补拉与实时更新，不让全量对象从另一条路径重新进 store。`read` 附件留到下一批，保留预览与原件访问。用同一份带大诊断映射的测试历史对比响应字节、页面可读时间和 renderer 占用，再据实报收益。只缩窗口会牺牲阅读历史，且挡不住单条大载荷；现有 400 条上限的理由见 [消息窗口记录](../notes/implemented/bug-fix/2026-10-09-gui-memory-unbounded.md)。

## 4. 只剩壁纸的消息区：未定因

故障截图里输入区、右栏和进度仍在；桌面日志未发现对应时段的 renderer 退出。这个现象与第 1 节整窗启动图不同，也没有证据说明压缩清空了展示历史。

复发时先在现有 renderer 取一份只读 DOM 快照，不刷新、不滚动。记录 `.scroll-view__viewport` 是否挂载、宽高、`scrollTop/scrollHeight`，以及排除 `bottom-spacer` 的 `[data-timeline-row]` 挂载数和与视口相交的行数。只记几何和数量，不记消息内容。若已开诊断录制，对齐 `timeline.merge`、`timeline.virtual-fallback` 和 `renderer.longtask`：[事件表](../../packages/app/src/context/gui-diagnostics.ts#L18) · [可见行检测](../../packages/app/src/pages/session/message-timeline.tsx#L1576)。

| 现场信号 | 下一步 |
| --- | --- |
| 视口未挂载或高度为零 | 查 ready 门、容器布局与隐藏状态。 |
| 视口正常但无行，或行全在视口外 | 对照 `timeline.merge` 的行数，区分数据为空、虚拟区间丢失和滚动锚点偏移。 |
| 行与视口相交但屏幕仍空 | 查 CSS 可见性、裁剪和遮挡；几何相交不等于画出来。 |
