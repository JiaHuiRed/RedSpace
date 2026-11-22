# RedSpace 架构整理 · 2026-11-22

审阅基线为默认分支 `master` 的 `422479ad`（香港时间 11 月 22 日 09:46）。首选治理对象是 GUI 会话时间线与输入框。二者同时具备三项信号：近期改动频繁，一个文件承担多个用户动作，以及同一条规则出现在第二个实现或测试替身里。[基线提交](https://github.com/JiaHuiRed/RedSpace/commit/422479addffb4b1b44b9c449cfc6c26b592d91d4)

## 近期哪些文件真的在长

从 11 月 13 日的 `d2f0ee1d` 到审阅基线，共 200 个第一父链提交。下表是人工核对过调用方的六个生产文件。行数包含注释与空行。触及次数按第一父链的路径历史计算，含合并，执行引擎在改名前后分别按两个目录名追踪。它反映维护接触面，不能直接换算为缺陷数量。

| 文件 | 11 月 13 日 | 11 月 22 日 | 净增 | 触及次数 |
| --- | ---: | ---: | ---: | ---: |
| [GUI 消息时间线](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/pages/session/message-timeline.tsx) | 2,588 | 3,143 | +555 | 10 |
| [TUI 会话路由](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/redspace/src/cli/cmd/tui/routes/session/index.tsx) | 3,315 | 3,615 | +300 | 13 |
| [GUI 会话页](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/pages/session.tsx) | 2,061 | 2,330 | +269 | 15 |
| [执行引擎 SessionPrompt](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/redspace/src/session/prompt.ts) | 2,962 | 3,229 | +267 | 16 |
| [GUI 主输入框](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/components/prompt-input.tsx) | 1,846 | 2,004 | +158 | 20 |
| [UI 消息片段](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/ui/src/components/message-part.tsx) | 2,819 | 2,897 | +78 | 9 |

输入框尤其容易被误判。只看最近 50 次主线提交，它从 2,089 行缩到了 2,004 行，说明模型弹层抽取已经见效。拉长窗口看，同一个入口仍被碰了 20 次。另一头，Web 图标表超过四千行，多数内容是图标定义；按行数排序会把它排到时间线前面，收益很有限。

## 这批改动解决了什么

| 位置 | 基线证据与改动 | 验证 |
| --- | --- | --- |
| Chat 首页与会话输入框 | `498a07c` 已统一四个输入场景的弹层。两个调用方仍重复投影供应商、过滤可见模型、组装行字段，Chat 还额外过滤一次默认推理档。现在弹层接收各自的目录与最近记录，统一生成列表，选择回调只交付模型键。首页仍使用伙伴目录、保留重置默认；会话保留付费引导、焦点恢复和会话内持久化。三个免费模型判定调用方共用同一函数。 | 编译实际 Solid 组件，在 Happy DOM 验证 9 项条件，覆盖可见性变化、目录刷新、最近供应商去重、跨供应商同名 ID、默认模型和键盘调整推理档。 |
| GUI 时间线与 UI 包 | 重复的推理标题解析、错误正文提取、文件 diff 去重进入 `@redcode-ai/ui/session-turn-data`。UI 轮次视图也改用已有的 `renderable`。行类型直接从实际变体推导，移除了落后于 `Thinking` 变体的手写镜像。按 part 记忆标题、活跃轮跳过 diff 的策略仍归时间线负责。 | 现有 app 时间线测试与 ui 分组、diff、档位测试共 80 项通过，包含 400 帧随机差分对照。 |
| 时间线测试 | 手写 mock 把每个工具转换为一行，也把所有工具视为可见。接上真实实现，两个旧断言失败。修订后的用例分别验证连续两次 `bash` 合成同一命令组，以及 `bash → read` 生成两个组并延续署名。 | 断言同时覆盖实际分组类型与署名序列。 |
| 包导出与发布脚本 | `@redcode-ai/app/pages/chat` 指向已移除的 `pages/chat/index.tsx`，包外解析失败。另一个故障在 `raw-changelog.ts`，它为 Git 选提交和为提交分组各维护一份目录。旧筛选复现漏掉 `6f0584c` 的 core 修复。现在 Chat 导出指向实际路由，发布筛选与分组共用同一张表，纳入当前执行引擎、core、llm、ui，并识别旧引擎目录。 | Bun 从 app 包解析子路径成功。用真实 Git 区间回放 Core、TUI、Desktop 分组，GitHub 比较元数据用本地夹具提供。 |
| 文件归档 | `docs/mockups` 下两份模型选择器 HTML 移入已有的 `docs/previews`，两个文件均为原样移动。10 月两份历史报告的 39 处源码证据改为各自基线提交的永久链接，其中 16 处仍引用旧引擎目录。 | 逐条用 Git 对象核对文件和锚点行号，历史结论保留原文。 |
| 单独可取的构建修复 | `60b9c07` 给头像补 `corner-shape` 时多写了一个右花括号。类型检查能通过，Tailwind 在生产构建报 `Missing opening {`。修复只有一行。 | 修复前打包能复现，修复后 app 生产构建通过。 |

## 下一批应从哪里下刀

### 1. 先拆 GUI 时间线的“找到并返回这条消息”

用户在会话里搜到一段工具输出，打开它指向的文件，再从文件返回。这一个动作已经穿过三层。会话页保存返回入口，时间线父组件负责虚拟列表定位、挂载重试、高亮与回退，`timeline-locate.ts` 负责展开组内的折叠正文。父组件还向会话页反向注册两个函数，卸载时再撤销。修改“返回工具后恢复到哪儿”时，需要同时弄清这两端的生命周期。[会话页入口](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/pages/session.tsx#L1507) · [定位与重试](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/pages/session/message-timeline.tsx#L1088) · [已有 DOM 定位逻辑](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/pages/session/timeline-locate.ts#L74)

下一刀只迁移定位及高亮的生命周期，复用已有的 DOM 定位函数。虚拟列表与原生列表各自提供定位能力，会话页继续持有路由。验收完整走一次“搜索命中折叠工具 → 展开并高亮 → 打开文件 → 返回原工具”；再测目标尚未挂载、目标已经消失时恢复原滚动位置。这样能把最容易回归的动作从三千行组件里取出来。

### 2. 输入框先拆编辑器，再考虑工具栏

`PromptInput` 的第 575 行开始处理插入点和焦点，第 627 行接管 IME，后面还负责补全幽灵文本、DOM 回写、历史导航、键盘分派与模型控件。输入中文时按 Enter、用方向键翻历史、换模型后恢复焦点都可能改写同一个编辑器状态。按页面或 JSX 上下半段切开，会把这些依赖藏进一长串回调里。[编辑器与 IME](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/components/prompt-input.tsx#L575) · [键盘分派](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/components/prompt-input.tsx#L1203)

把组合输入、光标恢复、草稿与 contenteditable 的同步放到已有的 `components/prompt-input/`，让这组逻辑拥有同一个编辑器引用。Chat 首页使用 textarea，会话使用 contenteditable；两者已经共用剪贴板分类，图片与文字的混合粘贴曾连续修到两个入口。继续共享分类与读取结果，保留两种编辑器各自的撤销、光标和附件额度处理。[首页修复](https://github.com/JiaHuiRed/RedSpace/commit/a325453) · [会话跟进](https://github.com/JiaHuiRed/RedSpace/commit/23bc57b)

### 3. TUI 先抽命令表；执行核心先抽消息构造

TUI 会话路由里，`sessionCommandList` 从第 888 行开始，直到第 1675 行才进入命令映射。同文件后半又负责 `UserMessage`、推理显示和十余种工具行。命令注册是现成的切口。先迁移一组相关命令，使快捷键、可用条件和执行动作留在一起，用现有快照及键盘测试验证。压缩状态值得第二步处理：GUI 有单测覆盖的纯函数，TUI 则在多组 memo 中维护近期摘要、错误和运行状态。可先共用“当前尝试是否 pending、失败原因如何提取”，TUI 的压缩前后主请求用量仍按它实际显示的数据计算。[TUI 命令表](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/redspace/src/cli/cmd/tui/routes/session/index.tsx#L888) · [TUI 压缩状态](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/redspace/src/cli/cmd/tui/routes/session/index.tsx#L2040) · [GUI 判据](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/app/src/pages/session/compaction-state.ts#L47)

执行核心的 `session/prompt.ts` 同时处理用户消息构造、引用解析、队列领取、压缩、取消与模型调用。仅 `runLoopImpl` 的定义和下一个 `loop` 声明就相隔约 1,400 行。优先沿已有 `session/prompt/reference.ts` 与 `shell.ts` 的边界拆出用户消息构造；让领取排队消息、取消及持久化顺序继续归同一个运行循环。验收重点是首次提交、运行中追加、取消与恢复各自只产生一次正确的消息记录。[消息构造](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/redspace/src/session/prompt.ts#L845) · [运行循环](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/redspace/src/session/prompt.ts#L1495)

### 4. 包边界按谁消费来定

- `app` 拥有伙伴目录、路由和会话状态。`ui` 拥有可复用的呈现规则。当前 `message-part.tsx` 既导出分组函数，又在模块求值时注册 15 组工具渲染器。时间线数据模块为了取得分组和可见性而导入整个消息渲染模块。下一步可为纯分组提供明确出口，给可见性判断保留已注册自定义片段的语义；需要对照生产入口的模块图才能声称包体或首屏有收益。[分组实现](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/ui/src/components/message-part-groups.ts#L64) · [渲染注册](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/ui/src/components/message-part.tsx#L1394)
- 桌面壳的 i18n 通过 `../../../../app/src/i18n/en` 跨包读 app 私有目录，用于构造基础字典。先核对壳侧实际使用的键，将开发期挂载错误归到桌面自己的翻译资源。移动 app 的字典目录就不必同步修改 Electron。其他语言已按需加载，这里没有重新做首屏体积测量。[跨包导入](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/desktop/src/renderer/i18n/index.ts#L19) · [开发期调用](https://github.com/JiaHuiRed/RedSpace/blob/422479addffb4b1b44b9c449cfc6c26b592d91d4/packages/desktop/src/renderer/index.tsx#L37)

## 验证口径

app、ui 和仓库脚本的类型检查通过，目录检查通过。模型选择器的 DOM 验证使用编译后的组件和实际滑杆，以受控目录和翻译键驱动。三条浏览器端到端用例在 Chromium 创建本地套接字时被执行环境拒绝，均未进入页面断言；窄窗飞出层的真实几何位置和端到端会话切换仍待浏览器环境验证。上述净增行数全部来自整理前的基线，未用行数变化推算性能收益。
