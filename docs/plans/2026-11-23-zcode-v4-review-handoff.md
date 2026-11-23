# ZCode v4.0.0 对照阅读记录（未完）

基线：ZCode 源码镜像 `D:\1！5！\Edge download\ZCode` 的 commit `a4b44451`（sync ZCode source v4.0.0，2026-11-23），对照上一版 `fec97590`（v3.18.2，2026-11-13）；RedSpace 侧对照 `v0.20.4`（`debde2b3`）。三份总览文档读完了（提示词契约、提示词快照、工具改动链）。**261123 补读：5.1–5.9 按设计文档加关键源码过了一遍，结论见第 5 节——9 项里 3 条值得跟、2 条可选、其余不跟或已有等价。** 其余约一半增量仍未读，清单见第 6 节。

下文 ZCode 的路径都相对于上面那个镜像的根目录，RedSpace 的路径相对于本仓根目录。

## 1. 规模与读法

2209 个文件，+149,753 / −24,801；新增 690、删除 15、修改 1404、重命名 100。

| 区域                                                              | 文件 | 增删             | 说明                                        |
| ----------------------------------------------------------------- | ---: | ---------------- | ------------------------------------------- |
| `apps/zcode-cli/packages/core`                                    |  297 | +23,298 / −3,467 | agent 核心：工具、运行时、子代理、MCP、压缩 |
| `apps/zcode-cli/packages/adapters`                                |  152 | +19,215 / −2,187 | 模型、MCP、技能、插件、存储、执行           |
| `apps/zcode-cli/packages/bootstrap`                               |  129 | +10,226 / −1,820 | 装配、协议、信任                            |
| `apps/zcode-cli/packages/contracts`                               |   50 | +848 / −382      | 工具与模型契约                              |
| `apps/zcode-cli/docs/design`                                      |   40 | +1,937 / −227    | 设计文档                                    |
| `packages/desktop`                                                |  687 | +49,499 / −3,672 | 其中 `test/e2e` 579 个文件                  |
| 顶层 `docs`                                                       |  220 | +15,100 / −3,559 | 混合：契约文档、e2e、监控、议题             |
| `packages/ui`                                                     |  176 | +10,514 / −4,344 | 界面                                        |
| 文档类插件（design、pdf、spreadsheets、documents、presentations） |  191 | +6,425 / −1,829  | 技能文档与脚本                              |

读法是先读 ZCode 自己维护的三份文档（提示词契约、提示词快照、工具改动链），再按文档指向去读源码。其余约一半增量按判断跳过，清单在第 6 节。

## 2. 结论

ZCode 这一版在 harness 层面做的事，RedSpace 大部分已经有，有几处更早（第 3 节）。提示词上它新加的两段，`default.md` 已有等价条款。值得 RedSpace 跟的是下面 7 条，按建议处理的先后排。

### 2.1 GLM 限流：瞬时限流的冷却在请求之间共享

ZCode 把 BigModel 的 `1302`、`1305` 归为可重试的限流（`failure-provider-business-codes.ts`，本次未改），`3010` 并发上限归为不自动重试。本次新增三处：

- 重试延迟改走 `retryDelayWithAdmissionCooldown`，等待取本地退避与准入端口剩余冷却的较大值。`runner-stream.ts` 里普通重试和流内 `error` chunk 两处同型。
- 限流事件没带 `retryAfterMs` 时，并发调节器按该请求自己的退避估一个冷却 `estimatedCooldownUntil`，上限 5 分钟，只供主代理重试参考。已经在跟随冷却的请求不记，避免几个会话互相把冷却越推越远。
- `readAdmissionRetryCooldownMs` 只在重试的退避里读，首次请求不读（`request-admission.ts`）。

注释给的原因：线上 1302 的 Retry-After 时有时无（glm-5.3 大多带，glm-5.3-flash 大多不带），不带时冷却永远不被设置；冷却期里的重试几乎一定还是 1302，只会白白耗掉重试次数。1302 常以 SSE `error` chunk 到达。

RedSpace 侧：用量耗尽类（1113、1308、1310、1316–1321）已归为不可重试并把重置时间写进消息（[error.ts](../../packages/redspace/src/provider/error.ts#L64)）；`retry-after`、`retry-after-ms`、`x-ratelimit-*` 的解析在 [executor.ts](../../packages/llm/src/route/executor.ts#L93)。1301、1302、1305 在 `packages/redspace/src` 和 `packages/llm/src` 的非测试源码里没有字面命中，推断走 429 的通用重试路径。

没核实：通用路径的次数与退避（[retry.ts](../../packages/redspace/src/session/retry.ts) 没读）；主代理与子代理之间有没有共享冷却。

现场：本轮三个子代理并发读这个仓库，两个在运行约 85 分钟和 100 分钟后以 `[1305] 该模型当前访问量过大` 失败，失败前各有约 15 分钟没有新进度，同时主代理的请求一直正常。是不是并发导致的，分不清。

### 2.2 提示词钉住的刷新时机

RedSpace 的系统段作用域把 `InstallationVersion` 算了进去（[prompt.ts](../../packages/redspace/src/session/prompt.ts#L1935)），注释写明升级会重新组装。所以 0.20.0 到 0.20.4 这三天的每一次升级，每个旧会话恢复时都要重建一次系统段。压缩结算不动 pin（[prompt-pin.ts](../../packages/redspace/src/session/prompt-pin.ts) 头注释）。

ZCode 相反：升级不动前缀，只在压缩成功或会话模型变更时清掉快照并重渲染（`prompt-snapshot.md`）。压缩后消息本来就被替换，这时换系统段几乎不丢缓存，提示词修复又能有界地到达旧会话。

没核实：钉住的工具定义在升级时是否同样失效；升级场景下重建前缀的实测代价。pin 注释里「321k token 全价重建」是 MCP 服务升级导致工具定义变化的场景，不是版本升级场景。

### 2.3 技能目录不进系统段

ZCode 把技能全量列表从系统段里拿掉了，改成运行时按实时目录追加增量：会话中途新装的技能立刻可见，且不动系统段字节（`core/src/context/builder.ts` 本次 diff 的注释，契约在 `docs/skills-live-catalog.md`）。Skill 工具按会话目录解析名称，`Bash` 里 `cd` 之后不再按当前目录重扫磁盘。

RedSpace 的系统段快照带一个 `skills` 字段（`SystemPin.skills`），随系统段一起钉住。

没核实：这个字段装的是目录全文还是引导语，以及 RedSpace 技能目录的渲染位置和上限。

### 2.4 MCP 不阻塞首请求

ZCode 让 MCP 在首个请求之后才连接，依据是工具改动链里的两条（2026-10-30「WaitForMcpServers 与连接中工具等待」和「MCP 动态目录与实时搜索」）：

- 模型调到还在连接的 server 的工具时，同一轮助手回复内最多等 10 秒，再查一次最新目录，仍没有才报「没有这个工具」。
- 另有一个 `WaitForMcpServers` 工具，最多等 5 秒，不重连、不授权。
- 旧的服务器状态公告不再投影给模型，状态并入搜索增量。
- MCP 结果在 `content` 和 `structuredContent` 之间只发一种（2026-11-11）。

RedSpace 侧：`src/mcp/` 下有 [reconnect-policy.ts](../../packages/redspace/src/mcp/reconnect-policy.ts)、[retry.ts](../../packages/redspace/src/mcp/retry.ts)、[health.ts](../../packages/redspace/src/mcp/health.ts)；`src/mcp` 里没有 `structuredContent` 字样。

没核实：首请求是否等待 MCP 连接；MCP 结果怎么投影给模型。

### 2.5 落盘的内容必须保证能重放

ZCode 修了两个会让会话持久失败的坑：

- Bash 输出里的坏图片（截断的 base64、类型与 magic bytes 不符）被当成图片块发给 provider，provider 拒绝；坏图作为附件持久化，冷恢复照样重放，会话后续请求全部失败。现在声明类型必须与 magic bytes 一致、缩放必须成功，否则回退为文本（2026-11-12）。
- 工具返回错误结果时 part 状态仍是 `completed`，冷恢复固定按成功回放，丢了 `is_error`：模型把失败当成功，缓存还从这条结果起失效。现在结算时写 `metadata.providerIsError`（2026-11-15）。

RedSpace 现在也把消息 parts 落盘重放（`prompt-pin.ts` v3，单条消息上限 512 KiB、系统段上限 256 KiB），同一条不变量适用。

没核实：RedSpace 的 shell 和 read 输出图片的路径，以及落盘前有没有校验。

### 2.6 Windows 下的 shell 方言

ZCode 修了三处，都在工具改动链里：

- 回落 shell 明确声明为 CMD（2026-11-17）。此前它的方言是「不支持」，guarded 模式对不支持的方言直接放行，危险命令匹配不到。
- 只读判定按实际执行的 shell 来。Memory Agent 的执行器是 yolo，CMD 会话下 `type # & ...` 能在后台执行任意命令（2026-11-16）。CMD 只读判定只认系统目录里的 `cmd.exe`，命令限 `dir`、`type`、`findstr`、`where` 和 git 只读子命令。
- Git Bash 发现逻辑漏检带引号的 PATH，首个 Git 不带 Bash 时提前结束（2026-11-19）。

没核实（RedSpace 侧完全没看）：权限层遇到不认识的 shell 方言是放行还是拒绝；只读自动放行是否按实际 shell 判定。相关文件是 [shell.ts](../../packages/redspace/src/tool/shell.ts)、[command-name.ts](../../packages/redspace/src/tool/command-name.ts) 和权限层。

### 2.7 前台长 sleep 拦截

ZCode 拒绝第一个顶层子命令是 `sleep N`（N ≥ 25 秒）的前台命令，模型收到 `<tool_use_error>Blocked: standalone sleep N. …</tool_use_error>`，被拒的调用不跑 hook、不请求权限、不启动进程。后台运行、执行端口不支持后台、shell 是 CMD 或回落 shell 时放行。同时在 Bash 描述里写明改用后台 until 循环（2026-11-15）。

RedSpace 的 [shell.ts](../../packages/redspace/src/tool/shell.ts) 里 `sleep` 只命中 `Effect.sleep` 定时器，没有命令级拦截。

### 2.8 提示词文案与流程

只有两句值得抄进 [default.md](../../packages/redspace/src/session/prompt/default.md)：

- 「If you notice yourself inviting the user to redirect you or offering to wait, instead proceed on the next part of the task.」
- 对难以撤销的操作，「an old or general go-ahead doesn't count as confirmation」。

提示词结构上两边取向不同，不判断优劣：ZCode 全仓一份英文提示词，新加的段对所有模型发送；环境、日期、Git 快照、回复语言都是带历史的附件，不进系统段。RedSpace 的 `session/prompt/` 有 23 个 md 片段，其中 12 份按厂商加 `default.md`，其余是功能片段。

流程上有一处差别：ZCode 每动一次工具或循环，就在 `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` 里追加一条带日期的记录，写明模型看到什么变了、缓存是否失效、回归在哪。全文 3020 行，改工具链之前读这一份就够。RedSpace 的「四问」写在 commit 说明里。

## 3. RedSpace 已有等价实现的部分

| ZCode v4.0.0                                            | RedSpace                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 系统段按会话落盘，冷恢复逐字节重放                      | 更全：工具定义、MCP guide、系统段、消息 parts 一起落盘（`prompt-pin.ts`，v3）          |
| 新增 `# Finishing work`、`# Memory, notes and feedback` | `default.md` 的「Autonomy and completion」「No summary documents unless asked」已覆盖  |
| 写前已读，mtime 变了再比内容哈希                        | [time.ts](../../packages/redspace/src/file/time.ts#L209) 同样的两级口径，2026-11-05 起 |
| 子代理后台运行，完成后通知                              | [task.ts](../../packages/redspace/src/tool/task.ts#L486) 支持后台、轮询、steering      |
| 超时与中断的结果文案                                    | [shell.ts](../../packages/redspace/src/tool/shell.ts#L212) 明确提醒副作用可能已发生    |
| 只读子代理继承父会话权限（2026-10-31 修复）             | 有 `src/agent/subagent-permissions.ts`，没读                                           |

## 4. 已读清单

### 4.1 逐个文件

| 对象                                                                                                                | 读了多少               | 要点                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md`                                                      | 全文 378 行加本次 diff | 系统提示分三段。`system[0]` 只有产品名一句；`system[1]` 是静态段（定位、安全边界、`# Harness`），走全局缓存；`system[2]` 是动态段（代码风格、代词、风险、会话指引、记忆、上下文管理、收尾、笔记）。本次新增收尾与笔记两段，对所有模型发送；回复语言移到 `language` 附件；token 预算行默认关闭 |
| `apps/zcode-cli/docs/design/v2/loop/prompt-snapshot.md`                                                             | 全文                   | 每会话一行记录当时的系统消息，模型一致才沿用；压缩成功或会话模型变更时清掉重渲染；工具列表不冻结；回退不动快照；fork 复制父会话的快照                                                                                                                                                         |
| `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`                                                        | 本次 diff 全部 584 行  | 逐条带日期的改动记录，索引见 4.2。未改动的旧条目没读                                                                                                                                                                                                                                          |
| `core/src/context/dynamic-sections.ts`、`builder.ts`、`types.ts`、`total-tokens.ts`                                 | diff                   | 两段新提示词原文；技能列表不再在系统段渲染；token 预算行由开关控制                                                                                                                                                                                                                            |
| `core/src/compact/prompt.ts`、`policy.ts`                                                                           | diff                   | 摘要只取一个文本块（最后一个含 `<summary>` 的）；摘要回复带工具调用时先判断选出的块是不是摘要；输出预留从固定 21K 改为「21K 与窗口 8% 取大」，再受模型输出上限约束                                                                                                                            |
| `adapters/src/model/runner-stream.ts`、`request-admission.ts`、`bootstrap/src/app/workflow-concurrency-governor.ts` | diff                   | 见 2.1。另：思考内容被拒后的自动修复不再只限 Anthropic                                                                                                                                                                                                                                        |
| `apps/zcode-cli/docs/design/v2/model/stream-error-retry.md`                                                         | 新版前 60 行           | AI SDK 可能把 429、5xx 作为流内 `error` chunk 产出而不是抛异常；重试前必须发失败与重试两个状态事件；零文本的增量属于可丢弃的前奏，非空思考输出必须立即释放                                                                                                                                    |
| `adapters/src/model/` 下限流相关的搜索                                                                              | 行级命中               | 1302、1305 的映射在 `failure-provider-business-codes.ts`                                                                                                                                                                                                                                      |
| 本会话注入的 ZCode 系统提示与工具描述                                                                               | 全文                   | 含本次新增的两段，可当作 v4.0.0 同期文本；没有逐字对照源码，也没有看改动前的版本                                                                                                                                                                                                              |

`core/` 是 `apps/zcode-cli/packages/core/` 的缩写，`adapters/`、`bootstrap/` 同理。

261123 补读的文件（结论见第 5 节，不再重复列表）：`docs/mcp-async-tool-catalog-cache.md`、`design/v2/mcp.md`、`design/v2/tool/19-tool-search.md`、`core/src/tool/search/{exposure,history,mcp-diagnostics}.ts`、`docs/model-tool-call-validation.md`、`design/v2/tool/12-input-normalization.md`、`core/src/tool/input-validation-model-content.ts`、`contracts/src/tools/json-schema.ts`、`design/v2/tool/04-bash.md`、`docs/bash-tool-ast-permission-semantics.md`、`docs/runtime-tools/bash-effective-shell-snapshot.md`、`core/src/tool/handlers/{bash-model-content,bash-semantics}.ts`、`docs/skills-live-catalog.md`、`design/v2/loop/meta-user-context.md`、`design/v2/model/stream-error-retry.md`、`design/v2/tool/07-subagent.md`、`design/v2/memory/README.md`、`design/v2/tool/17-read-file-state-resume.md`、`docs/hooks-runtime-contract.md`、`design/v2/tool/01-read.md`。RedSpace 侧核对了 `mcp/index.ts`、`tool/{registry,tool,shell,read,json-schema,invalid}.ts`、`session/{retry,prompt,prompt-pin}.ts`、`file/time.ts`、`session/tools.ts` 的 plugin trigger 路径。

### 4.2 工具改动链条目索引

只列本轮 diff 里的条目。日期是条目标题里的日期；标「无日期」的条目，标题不在本次 diff 里，日期未知。

**给模型的文本与错误**

| 日期  | 条目                                 | 要点                                                                                                                                                                            |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11-15 | Bash 前台长 sleep 拦截与描述三处文字 | 见 2.7；Bash 描述另改 `cd` 一行和 GitHub `@name` 提醒                                                                                                                           |
| 11-14 | 工具错误的包装与文字                 | 可预期的失败统一包成 `<tool_use_error>`；权限拒绝、hook 拒绝、I/O 异常不包。Skill 找不到给编辑距离不超过 2 的「Did you mean」；hook 命令可能带凭据，报错里写 `[command hidden]` |
| 11-13 | 工具错误包装与 Read 输入修正         | 未知工具的后缀分三类（Grep/Glob 改用 Bash、内置工具在本上下文未注册、大小写写错）；Read 先把数字字符串转成数字再校验                                                            |
| 11-12 | Bash 硬超时结果                      | `Exit code 143`、`Command timed out after <时长>`、已采集输出，标 `is_error`                                                                                                    |
| 11-12 | 后台 Bash 改目录的说明               | 后台命令的 `cd` 不影响后续命令，结果里写明                                                                                                                                      |
| 11-21 | Skill 结果的工作流工具未激活提示     | 工具面未激活时告诉模型不要调用，主会话与子代理两段文案                                                                                                                          |
| 11-20 | node_repl 无进展提示撤销             | 删掉「You may end this turn.」提示，不再追加                                                                                                                                    |

**持久化与重放**

| 日期  | 条目                                 | 要点                                       |
| ----- | ------------------------------------ | ------------------------------------------ |
| 11-15 | 错误结果标记随 completed part 持久化 | 见 2.5                                     |
| 11-12 | Bash 图片输出必须解码成功            | 见 2.5                                     |
| 11-11 | 读取状态快照只存正文哈希             | 落盘只存 `contentSha256`，写前陈旧校验等价 |
| 11-11 | MCP 结果去重                         | 见 2.4                                     |

**权限与安全**

| 日期     | 条目                                    | 要点                                                                         |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| 11-17    | Windows 回落 shell 按 CMD 声明          | 见 2.6                                                                       |
| 11-19    | Windows Git Bash 安装发现               | 见 2.6                                                                       |
| 11-09 起 | CMD 自动授权收紧与恢复                  | 见 2.6                                                                       |
| 11-16    | 草稿写入的执行点符号链接防护            | 免确认的草稿目录若是符号链接会写出工作区，在真正写入时逐级 `lstat` 拒绝      |
| 11-16    | Git 工作流读取禁用外部 diff 与 textconv | 只读查询带 `--no-ext-diff --no-textconv`                                     |
| 无日期   | 拒绝工作区控制的 adb                    | Bash 只拒绝工作区内的 adb，SDK 路径放行                                      |
| 11-14    | Bash 只读名单补充                       | 补压缩包列表、Windows 查询、`iconv`、`xxd`、`command -v` 和几条 git 历史查询 |

**MCP 与技能**

| 日期   | 条目                               | 要点                                                             |
| ------ | ---------------------------------- | ---------------------------------------------------------------- |
| 10-30  | WaitForMcpServers 与连接中工具等待 | 见 2.4                                                           |
| 无日期 | MCP 动态目录与实时搜索             | 见 2.4；执行时「准入、晚绑定当前连接、会话过期时重连并重试一次」 |
| 10-29  | node_repl frontend 自动重启        | 10 分钟内最多 5 次                                               |
| 11-10  | Skill 名称解析读会话目录           | 见 2.3                                                           |

**子代理**

| 日期  | 条目                                   | 要点                                                                                                                                |
| ----- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 11-18 | Agent 总在后台运行开关                 | 默认开启，输入里不再有 `run_in_background`；结果经 `<task-notification>` 在之后的回合送回；描述里写明「不要编造未完成子代理的结果」 |
| 10-29 | 立即发送时前台 Agent 转后台            | 用户立即发送新消息时，前台子代理转后台而不是被取消                                                                                  |
| 10-29 | 前台 Agent 启动阶段停止的终态事件      | 修正「子代理一直显示运行中」和「两条终态」                                                                                          |
| 11-10 | SendMessage 不在上一次运行未结束时恢复 | 防止同一子会话上同时跑两个运行时                                                                                                    |
| 11-10 | SendMessage 冷恢复后找回子代理         | 身份写成结构化字段（`agentId`、`childSessionId`、`outputFile`、`background`），不再从模型可见文本里正则取                           |

**Schema、hook 与提醒**

| 日期   | 条目                  | 要点                                                                                                                                  |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 11-14  | 工具 JSON Schema 生成 | 统一走 zod 4 的 `toJSONSchema`；`oneOf` 改 `anyOf`；根节点只能是 `type: object`（Anthropic 拒绝根节点上的组合关键字）；元数据键排最前 |
| 无日期 | 错误结果的 Hook 事件  | 错误结果只跑 `PostToolUseFailure`                                                                                                     |
| 11-15  | 持续静默提醒          | 改为按 60 秒计时                                                                                                                      |

## 5. 补读结论（2026-11-23）

口径：不是「ZCode 有就抄」。每项只回答两件事——它解决的具体问题是什么、RedSpace 是否有同一个问题。没有就不跟；有再讨论跟哪一层。

### 5.1 MCP 与工具曝光

**它的解**：没有按 token 预算裁剪工具，而是 deferred/常驻二分——`shouldDefer` 或 `mcpPresentation` 的工具默认只发一行名称公告、不发 schema，模型用 `ToolSearch`/`LocalToolSearch` 按需拉定义；`alwaysLoad` 常驻；每个 step 的请求投影固定快照，执行时晚绑定当前连接；MCP 状态（pending/needs-auth/failed）并进名称 delta。目录缓存 32 条 / TTL 30 分钟 / 单条 2 MiB / 总 16 MiB，只在协议入口启用、远程不缓存。

**我们的现状**：`mcp/index.ts` 有懒启动（`startup:"lazy"` + 本地 + 磁盘缓存非空才 defer）、cache-first 兜底、gated + `search_tools`（固定 `GATED_TOOLS`，激活后整份 schema 进工具表）。没有 deferred schema 投影，也没有 MCP 状态段——工具缺席即不可见。

**跟不跟：不跟功能面。** RedSpace 的 gated 是「按需激活固定集合」，与它的「按引用动态加载」是两种解；换成 ToolSearch 要重做请求投影、历史持久化和缓存边界，收益不抵成本。值得留意的只有一条稳定性约束：工具表在一个 step 内不抖（我们每次请求重建工具表，`shouldDeferStartup` 已保证懒启动不抖）。状态段是可选体验项，先看真实失败频率。

### 5.2 工具入参校验与错误文案

**它的解**：四类分行模板（missing / unexpected / wrong type / other，other 最多 20 条、单条 500 码元）；未知工具五类后缀（MCP 状态、Grep/Glob 改 Bash、子代理不可用、大小写、无）；解析失败专用文案带原串预览；JSON Schema 由 zod 4 `toJSONSchema` + `anyOf` 归一 + 元数据前置。

**我们的现状**：`InvalidArgumentsError` 单行 `The <tool> tool was called with invalid arguments: <detail>. Please rewrite...`，`detail` 默认 `String(error)`，无分行/截断；未知工具靠 AI SDK 报错，无后缀；JSON Schema 由 Effect Schema `toJsonSchemaDocument` + 归一化（根对象兜底、nullable 剥离、allOf 压平、`$defs` 内联）+ `unknownArgumentKeys` 查顶层额外参数。

**跟不跟：文案模板可跟，低优先。** 收益可量化（少一轮重试），尤其是「多余参数」和「类型不符」两类；代价是自定义 formatter 要覆盖 Effect Schema 的 issue 形状。未知工具后缀不照搬：工具表由 AI SDK 组装，Grep/Glob 那套是 ZCode 自己的工具面事实。

### 5.3 Bash 工具（同时回答 2.6 / 2.7）

**它的解**：非零退出除语义型（grep 无匹配、diff 有差异、test false）外投影为 `is_error` + `Exit code N`；硬超时固定 143 + `Command timed out after <时长>`；中断追加 `<error>Command was aborted before completion</error>`；失败结果不落盘、头尾各留 5000 字符；前台 `sleep N`（N≥25s）在 `validateInput` 拒绝，不跑 hook、不请求权限、不启动进程；Windows 找不到 Git Bash 时显式返回 `dialect=cmd`（不再 `system shell`），Guarded 按 CMD 语法匹配。

**我们的现状**：`shell.ts` 非零退出只进 `metadata.exit`，模型正文没有 `Exit code N`；超时/中断用 `<shell_metadata>` 文本；没有前台 sleep 拦截；`Shell.choose` 支持 pwsh/bash，`cmd` 只在 Explore 明确拒绝。

**跟不跟**：**前台 sleep 拦截值得跟**（独立、收益明确、文案可复用）；**`Exit code N` 前缀值得跟**（模型现在只能靠输出猜失败，pwsh 的 `$LASTEXITCODE` 不可见）；**Windows CMD 方言不跟**——RedSpace 是 pwsh-first，`cmd` 只在 Explore 拒绝，不存在「模型以为能跑 bash」的同一问题。语义型非零退出的排除表要按我们的 shell 重写（`Select-String`、`diff`、`Test-Path`）。

### 5.4 技能目录不进系统段

**它的解**：系统段只留引导语，列表改成运行时增量（按行指纹追加、删除不通知），`Skill` 调用时按名查内存快照、未命中 flush 重读；文件监听只更新快照。

**我们的现状**：`SystemPin.skills` 是渲染后的整份列表字符串，随系统段钉住（`prompt-pin.ts:38`），会话内不变。

**跟不跟：不跟。** 固定列表正是为了前缀字节稳定，这是我们的取舍；中途装 skill 立即可见是低频需求，且要重做列表持久化和 compact 语义。若以后要做，最小形态是「只追加新行、不改旧字节」，不需要它的文件监听栈。

### 5.5 重试与限流

**它的解**：GLM 1302/1305 归可重试；瞬时限流冷却在请求间共享（`retryDelayWithAdmissionCooldown` 取退避与准入冷却的较大值）；没有 `retryAfterMs` 时按请求自身退避估冷却，上限 5 分钟；首次请求不读冷却。

**我们的现状**：`session/retry.ts` 10 次上限、3s→6→12→15s（无响应头封顶）、`retry-after` 上限 5 分钟、5xx 强制重试、ContextOverflow/工具输入守卫不重试；1301/1302/1305 无字面命中，走 429 通用路径。

**跟不跟：暂不跟。** RedSpace 以单会话主请求为主，1302 的实际频率没有取证；先补日志再决定要不要共享冷却。更便宜的一条是**把 1302/1305 从「猜 429」改成显式分类**，避免被当成可重试的 5xx 无限重试。这条本身不是照抄它的冷却设计。

### 5.6 运行时提醒、压缩、续写、标题

**它的解**：60 秒静默提醒；输出 token 续写；标题生成 sidecar；compact 摘要只取一个 `<summary>` 块、输出预留取「21K 与窗口 8% 取大」。

**我们的现状**：compaction 已有（`session/compaction.ts`、token 顶帽 2M）；没有输出续写、没有标题生成 sidecar；提醒走现有 reminder 机制（未逐行核实）。

**跟不跟：续写不跟**——它会在 `max_output_tokens` 配置错误时掩盖问题，且 compaction 已覆盖长上下文；标题生成可选（GUI 体验，当前标题靠用户或首条消息）；compact 的「输出预留取大」值得核对我们现有预留是否够，纯参数判断。

### 5.7 子代理、记忆、读取状态

**它的解**：Agent 默认后台、完成通知、结构化身份字段（`agentId`/`childSessionId`/`outputFile`/`background`）；read-state 从 completed tool part metadata 冷恢复（只存 `contentSha256`）；记忆 agent loop。

**我们的现状**：`tool/task.ts` 已支持后台/轮询/steering；`file/time.ts` 两级口径（mtime 变了再比内容哈希）已有；子代理身份已在 task 元数据里。

**跟不跟：不跟。** Agent 总后台是 ZCode 的产品选择，和 RedSpace「前台子代理 + 用户可打断」的交互不同；read-state 和身份字段我们已有等价实现。

### 5.8 Hooks、信任、符号链接

**它的解**：7 事件闭环、`process`/`command` 两种、项目 hook 隔离 + Trust admission + rollout gate。

**我们的现状**：`plugin.trigger` 的 PreToolUse/PostToolUse 路径，权限与 hook 分层。

**跟不跟：不跟。** 两套信任模型不同，移植会把 RedSpace 的 plugin 权限面拆成两套；只做局部核对（hook 拒绝时的文案与副作用提示）。

### 5.9 文件工具描述

**它的解**：Read 输入修正（单元素数组、数字字符串、负数/0 删除、`length`→`limit`），provider-visible schema 不变。

**我们的现状**：`read.ts` 的 `offset`/`limit` 是 `NonNegativeInt`，不做隐式修正。

**跟不跟：可选，低优先。** 收益是少一轮重试，代价是引入隐式修正语义。若做，只做「数字字符串」和「单元素数组」两条，负数/0 交给 schema 报错。

**总账**：9 项里明确值得跟的只有 3 条——前台长 sleep 拦截、非零退出 `Exit code N`、1302/1305 显式分类；可选低优先 2 条（校验文案模板、Read 输入修正）；其余是「已有等价」或「产品取向不同，不跟」。

## 5. 附：原未读清单（已按上文补读）

按对 RedSpace 的价值排。规模是本次 diff 的增删行数。每一项建议单独一次定向读，只回答表里的问题。

### 5.1 MCP 与工具曝光（高）

对象：

- `docs/mcp-async-tool-catalog-cache.md`（+242 / −850）、`apps/zcode-cli/docs/design/v2/mcp.md`、`mcp-node-fallback.md`、`tool/19-tool-search.md`
- `core/src/tool/search/`：`exposure.ts`（+217）、`mcp-diagnostics.ts`（+141）、`history.ts`（+105）、`description.ts`
- `core/src/runtime/methods/mcp.ts`（+448 / −176）、`core/src/mcp/`（6 个文件，其中 `runtime/session.ts` +263）、`core/src/tool/handlers/wait-for-mcp-servers.ts`（+129）
- `adapters/src/mcp/`（9 个文件，+1,913 / −600）

要回答：工具太多时预算怎么算、怎么排序、哪些被延迟；MCP 没连上或失败时模型看到什么；目录缓存什么、何时失效；MCP 结果怎么投影。

对照 RedSpace：`src/mcp/` 的 [index.ts](../../packages/redspace/src/mcp/index.ts)，以及首请求是否等 MCP（[prompt.ts](../../packages/redspace/src/session/prompt.ts) 里 MCP guide 的装配）。

### 5.2 工具入参校验与错误文案（高）

对象：

- `docs/model-tool-call-validation.md`（+164 / −72）、`apps/zcode-cli/docs/design/v2/tool/12-input-normalization.md`
- `core/src/tool/input-validation-model-content.ts`（+118 / −302）、`tool-input-validation-issues.ts`、`levenshtein.ts`、`json-schema.ts`、`core/src/tool/executor/` 下的 `validation.ts`、`call-runner.ts`、`errors.ts`、`live-entry-resolution.ts`
- `contracts/src/tools/json-schema.ts`（+36 / −180）、`contracts/src/model/unparsed-tool-input.ts`、`adapters/src/model/tool-input-normalization.ts`

要回答：模型看到的校验错误原文；未知工具的提示后缀；JSON Schema 生成规则。

对照 RedSpace：[registry.ts](../../packages/redspace/src/tool/registry.ts#L662) 的 `formatValidationError`、`tool/invalid.ts`、`tool/json-schema.ts`、[tool.ts](../../packages/redspace/src/tool/tool.ts#L19) 的 `InvalidArgumentsError`。

### 5.3 Bash 工具（高）

对象：

- `apps/zcode-cli/docs/design/v2/tool/04-bash.md`（+186 / −15）、`apps/zcode-cli/docs/bash-tool-ast-permission-semantics.md`（+48）、`docs/runtime-tools/bash-effective-shell-snapshot.md`
- `core/src/tool/handlers/bash-cmd-readonly-policy.ts`（+339）、其余 `bash-readonly-policy-*.ts`、`bash-command-parser.ts`（+86）、`bash-semantics.ts`（+57）、`bash-prompt.ts`、`bash-model-content.ts`、`bash-output.ts`、`core/src/tool/cmd-readonly/`
- `adapters/src/exec/`（8 个文件）、`contracts/src/tools/bash.ts`

要回答：Bash 描述本次改了哪三句；AST 只读规则；`is_error` 按命令语义怎么判（改动链说非零退出、超时、取消算错，grep 和 rg 退出 1 不算）；Windows 下 shell 的选择与发现。

对照 RedSpace：`tool/shell.ts`、`tool/command-name.ts`、权限层。这一项同时回答 2.6 和 2.7。

### 5.4 动态上下文与技能目录（中高）

对象：

- `apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`（+173 / −33）、`turn-steering.md`（+46）、`skill.md`、`docs/skills-live-catalog.md`（+135）
- `core/src/context/sections/env-info.ts`、`skills.ts`、`core/src/skills/`（6 个文件）、`core/src/tool/handlers/skill.ts`（+143）
- `adapters/src/skills/`（3 个文件）、`bootstrap/src/app/dynamic-skill-catalog.ts`

要回答：附件是发一次还是每次请求都发；技能目录的格式和上限；增量公告长什么样。

对照 RedSpace：`SystemPin.skills` 装的是什么、`tool/skill.ts`。这一项补 2.3。

### 5.5 重试与限流的其余部分（中高）

对象：

- `adapters/src/model/runner-retry.ts`（+63）、`retry-policy.ts`、`empty-completion-retry.ts`、`failure-classifier.ts`、`failure-provider-business-codes.ts`（本次未改，读全文）、`docs/dynamic-workflow/concurrency.md`（+61）
- `adapters/src/model/reasoning-history-normalization.ts`（+85）、`transform.ts`、`apps/zcode-cli/docs/design/v2/model/` 下三份

要回答：重试次数、退避、哪些错误明确不重试；1302、1305 的完整映射；思考内容在多轮之间怎么保留和回放。

对照 RedSpace：`session/retry.ts`、`provider/error.ts`、`packages/llm/src/route/executor.ts`。这一项补 2.1。

### 5.6 运行时：提醒、压缩、续写、标题（中）

对象：`core/src/runtime/`（64 个文件，+1,779 / −676，本轮只碰了提示词相关）。优先 `turn-output-token-continuation.ts`、`helpers/runtime-reminders.ts`、`helpers/compact-task-status.ts`、`context-refresh.ts`、`background-notifications.ts`、`title-generation-sidecar.ts`、`model-token-limits.ts`；文档 `apps/zcode-cli/docs/design/v2/compact/`、`rewind-compact.md`、`session-title-generation.md`。

要回答：提醒文案和 60 秒静默提醒的规则；输出 token 续写的提示原文和次数；标题生成的提示词与去重；上下文窗口上限从哪来。

对照 RedSpace：[compaction.ts](../../packages/redspace/src/session/compaction.ts)。

### 5.7 子代理、记忆、读取状态（中）

对象：

- `core/src/subagent/`（4 个文件，`runner.ts` +425 / −59）、`core/src/tool/handlers/agent.ts`、`send-message.ts`、`task-stop.ts`、`apps/zcode-cli/docs/design/v2/tool/07-subagent.md`（+106）
- `core/src/memory/memory-agent-loop.ts`、`runtime/helpers/project-memory-*.ts`、`adapters/src/memory-diagnostics/`、`apps/zcode-cli/docs/design/v2/memory/README.md`
- `apps/zcode-cli/docs/design/v2/tool/17-read-file-state-resume.md`（+55）、`core/src/tool/read-file-state*.ts`、`core/src/agent/`（4 个文件）

要回答：Agent 工具描述原文；完成通知文案；记忆保存的提示词；快照只存哈希之后怎么冷恢复。

对照 RedSpace：`src/agent/`、`tool/task.ts`、记忆技能。

### 5.8 hooks、信任、符号链接（中低）

对象：`core/src/hooks/`（8 个文件）、`docs/hooks-runtime-contract.md`、`bootstrap/src/workspace-plugin-trust/`、`adapters/src/plugins/`（17 个文件）、`adapters/src/watch/`（+557）、`adapters/src/fs/symlink-guard.ts`。

### 5.9 文件工具描述（低）

对象：`apps/zcode-cli/docs/design/v2/tool/` 下的 `01-read.md`、`02-write.md`、`03-edit.md`、`13-websearch.md`，以及对应的 handler 和 `contracts/src/tools/`（24 个文件）。现行描述可以从一次 ZCode 会话注入的系统提示里直接看，缺的是改动前后的对照。

## 6. 按判断跳过的部分

下面这些没有打开过，「与 harness 行为无关」是从路径和改动量推断的，不是读过之后的结论。

- `packages/desktop/`（除 `src/main/` 和 `src/preinstalled-tools/` 外主要是 e2e）、`packages/ui/`，以及顶层 `docs/` 里的 e2e、监控、i18n、协议投影文档
- 文档类插件及其技能：`design-plugin`、`pdf-plugin`、`spreadsheets-plugin`、`documents-plugin`、`presentations-plugin`；`docs/preinstalled-tools/`（LibreOffice、Python、Poppler、Pandoc、qpdf 的预装说明）
- `docs/superpowers/`（是计划和规格文档，不是技能提示词）、`docs/issues/`
- CUA、iOS、Android、浏览器插件；`bootstrap/src/zcode-protocol-v4/`；第三方声明与锁文件
- `00-tool-change-chain.md` 本次未改动的约 2,400 行旧条目

## 7. 续读方法

```
Z="/d/1！5！/Edge download/ZCode"
g() { git -C "$Z" -c core.fsmonitor=false --no-pager "$@"; }
g diff --no-ext-diff --no-textconv fec97590 a4b44451 -- <路径>     # 某文件的 diff
g show a4b44451:<路径>                                            # 新版全文
g diff --no-ext-diff --no-textconv --numstat fec97590 a4b44451    # 改动清单
```

踩过的坑：

- 路径里有空格和两个全角感叹号，变量必须整体加双引号。
- 这是下载来的目录，只跑只读的 git 命令。不跑 `git status`（会触发 fsmonitor），不执行里面的脚本。
- 不要用 `cut -c` 截断带中文的行，会截在多字节字符中间，整段输出变乱码，Read 工具也会拒读。
- `git grep <tree> -- 'a/*/src'` 这类带通配的 pathspec 匹配不到文件，会静默返回空。先整体搜，再滤掉测试文件。
- 单次输出超过约 30 KB 会被转存，预览是乱码。先落到临时文件，再用 Read 分页读。
- 不要开子代理并发读。本轮三路并发，两个被 1305 打死，一个多小时没有任何产出。

## 8. 可信度

- 写明「diff 里读到」或给出文件和行号的，是逐行读过 diff 或文档的。写「没核实」的，是只凭路径、搜索命中或改动量做的判断。
- ZCode 现行提示词和工具描述的来源是本会话注入的系统提示，不是源码。
- 261123 补读后，2.1 的「通用重试次数与退避」、2.3 的 `SystemPin.skills` 内容、2.6 的 shell 方言解析、2.7 的 sleep 现状已经核实（见第 5 节）；2.2 的升级重建代价、2.4 的首请求 MCP 等待与结果投影、2.5 的图片落盘校验仍未核实。
- RedSpace 侧只核对了第 2、3、5 节列出的位置。
- 这份文档不是决策记录。哪一条要动手，先按 `docs/notes/` 的规则另立 note 并回链。
