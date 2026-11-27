# RedSpace 用户手册

第一次使用，先[启动应用](#1-快速启动)，再[接入模型](#21-添加-ai-模型)。如果已有伙伴档案，见[导入 Chat 个人档案](#65-redspace-chat-个人档案)。

手册中的 `~` 指当前用户的主目录。命令行支持 `redspace` 和兼容名 `redcode`；配置目录仍是 `~/.redcode/`。

---

## 目录

1. [快速启动](#1-快速启动)
2. [首次设置](#2-首次设置)
3. [配置模型](#3-配置模型)
4. [MCP 服务器](#4-mcp-服务器)
5. [AI 人格系统](#5-ai-人格系统)
6. [记忆系统](#6-记忆系统)
7. [配置详解](#7-配置详解)
8. [内置命令](#8-内置命令)
9. [Skill 技能系统](#9-skill-技能系统)
10. [隐私与多机同步](#10-隐私与多机同步)

---

## 1. 快速启动

### 前置要求

- Windows 10/11（其他平台未经测试）
- Git、Node.js 24 和 [Bun](https://bun.sh) 1.3.14

### 克隆并运行

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
```

装好依赖后，在**仓库根目录**任选一个入口：

| 界面      | 启动命令              |
| --------- | --------------------- |
| 终端 TUI  | `bun dev`             |
| 桌面 GUI  | `bun run dev:desktop` |

两个入口都直接运行源码，不需要先打包。

### 编译打包

需要独立的终端程序或桌面安装包时，从仓库根目录选择下面对应的一组命令。

Windows 也可以双击 [TUI 构建脚本](packages/redspace/build.bat)或[桌面打包脚本](packages/desktop/build-and-package.bat)。两者都会先把 `seed/` 中的共享资源同步到 `~/.redcode/`；TUI 脚本还会跳过内嵌 Web UI。如果不希望同步本机配置，使用下面的命令。

```bash
# TUI：单文件 exe（Windows x64），可在没有 Bun 环境的机器上运行
cd packages/redspace
bun run build
# 产物（相对仓库根目录）：packages/redspace/dist/redcode-windows-x64/bin/redcode.exe
```

```bash
# 桌面 GUI：先构建，再用 electron-builder 打安装包
cd packages/desktop
bun run build
bun run package
```

TUI 的编译产物名为 `redcode.exe`。只复制这个文件时，后面的 CLI 示例用该 exe 运行；从源码运行时，用 `bun dev` 代替 `redspace`。

### 启动后发生了什么

第一次启动时，系统自动：

1. 创建 `~/.redcode/` 目录（存放全局配置和记忆），以及 `souls/` 子目录（`memory/` 只作归档，不再写入）
2. 补齐 `souls/karina.md`、`souls/yuqi.md` 与 `MEMORY.md` 的缺省模板——模板**编译时内嵌在二进制里**，已有文件与自定义正文不覆盖；旧 `Tsoul.md` / `Gsoul.md` 迁移时保留原文件与正文
3. 从可找到的 `seed/skill/` 播种技能到 `~/.redcode/skill/`（只补不覆盖）。先查当前目录，再查可执行文件上一级的 `seed/skill/`；单独复制 exe 不保证附带这些文件，缺失时会记录警告，技能也可自行安装
4. 加载配置、MCP 服务器与 skill 技能
5. 启动 TUI/GUI 界面

界面打开后，如果还没有可用模型，按 [2.1 添加 AI 模型](#21-添加-ai-模型) 配好再发第一条消息。

---

## 2. 首次设置

### 2.1 添加 AI 模型

使用云端 API 时，把连接信息写入本机的 `~/.redcode/redcode.local.jsonc`；文件不存在就新建。下面以 DeepSeek 为例，请替换密钥，并选择你的账号可用的模型。真实密钥不要写进要提交或同步的配置。使用本地模型则跳到 [3.3 Ollama](#33-本地模型ollama)。

```jsonc
{
  "provider": {
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "apiKey": "sk-xxxxxxxx",
        "baseURL": "https://api.deepseek.com/v1",
      },
    },
  },
  "model": "deepseek/deepseek-chat",
}
```

`npm` 选择协议适配器，不是 `type`；`apiKey` 和 `baseURL` 都写在 `options` 里，不放在 provider 顶层。换服务商时，见 [3.1 选择适配器](#31-选哪个适配器npm)。[仓库配置模板](seed/redcode.home.jsonc)包含多个服务的设置，按需取用即可。

### 2.2 设置称呼

`redcode.jsonc` 的 `username` 字段提供用户名称（不填则用电脑名）：

```jsonc
{ "username": "哥哥" }
```

具体称呼、AI 的性格、语气与协作方式写在灵魂文件里（见 5.1）。早期的 `~/.redcode/USER.md` 已下线，不再被加载；旧文件留着也无影响，可以自行删除。

### 2.3 自定义 AI 人格

Soul 文件定义 AI 的身份、性格、语气与协作方式。TUI 和 GUI 都可以选择同一份 Soul。用文本编辑器打开 `~/.redcode/souls/` 下对应的 `.md` 文件，例如在 PowerShell 中运行 `notepad "$HOME\.redcode\souls\karina.md"`。

灵魂文件的正文写法自由，但开头需要 YAML frontmatter（`id`、`name` 等，完整写法见 5.3）；建议正文包括：

- AI 的身份和名字
- 怎么称呼你
- 语气风格（简洁/详细、正式/随意）
- 重点帮你做什么
- 不该碰的话题

**人格自动加载**：新会话保存所选 Soul 的 ID，之后由这个 ID 加载人格，不再由客户端决定身份。TUI 用 `/soul`，GUI 用设置里的 Soul 选择器修改后续新会话的默认值；当前会话不换人格。Soul 文件保存后在新会话生效。

---

## 3. 配置模型

### 3.1 选哪个适配器（`npm`）

配置里没有 "provider 类型" 这个概念——决定走哪套协议的是 `npm` 字段，填的是 AI SDK 适配器包名。

| `npm`                       | API 格式       | 适用                                                           |
| --------------------------- | -------------- | -------------------------------------------------------------- |
| `@ai-sdk/openai-compatible` | OpenAI 兼容    | DeepSeek、Moonshot、Ollama、Groq、Step、GLM、MiniMax、各类中转 |
| `@ai-sdk/anthropic`         | Anthropic 原生 | Claude 官方 API                                                |
| `@ai-sdk/google`            | Gemini 原生    | Google Gemini 官方 API                                         |

绝大多数国内服务和自建服务都提供 OpenAI 兼容端点，用第一行即可——GLM、MiniMax 也在此列，它们不需要专门的适配器。省略 `npm` 时按 OpenAI 兼容处理。

### 3.2 切换模型

对话时点击模型选择器切换，或在 `redcode.jsonc` 中设置默认模型：

```jsonc
{
  "model": "my-provider/my-model"
}
```

`my-provider` 是供应商 ID，`my-model` 是该供应商下的模型 ID。配置自定义模型时，这两个值分别对应 `provider` 和 `models` 下的键名。

### 3.3 本地模型（Ollama）

先安装 [Ollama](https://ollama.com) 并让它保持运行，再拉取模型：

```bash
ollama pull qwen2.5-coder:7b
```

然后在 `~/.redcode/redcode.local.jsonc`（只在本机生效）或 `~/.redcode/redcode.jsonc` 里加入 provider 与默认模型。没有这个文件就新建一个，JSONC 允许注释和尾逗号：

```jsonc
{
  "provider": {
    "ollama": {
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen2.5-coder:7b": {
          "name": "Qwen2.5 Coder 7B",
          "temperature": true,
          "tool_call": true,
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  },
  "model": "ollama/qwen2.5-coder:7b"
}
```

`temperature` 和 `tool_call` 描述服务端实际支持的能力，把它们设为 `true` 不会让模型获得新能力。`limit` 按实际可用窗口填写；用量显示和自动压缩都会参考它。

---

## 4. MCP 服务器

MCP（Model Context Protocol）让 AI 按需要接入外部工具。

仓库的 `seed/redcode.home.jsonc` 提供以下服务的配置模板，不代表首次启动就已安装全部依赖。先安装对应程序，再启用所需服务；本机是否可用，以实际配置与连接状态为准。

### 4.1 代码智能

| 服务器         | 用途                                                               | 首次使用前                                                                                |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **jCodeMunch** | 结构化代码检索：符号、引用、调用链与影响范围，具体工具取决于白名单 | 安装服务后，让 AI 用 `jcodemunch_index_folder` 索引目标工程；模板关闭 AI 摘要，可按需开启 |

### 4.2 文件与文档

| 服务器         | 用途                                                                                   | 首次使用前 |
| -------------- | -------------------------------------------------------------------------------------- | ---------- |
| **markitdown** | 二进制文档转 Markdown：`.docx`/`.xlsx`/`.pptx`/`.pdf` 等 read 读不了的文件用它提取文本 | —          |
| **fff**        | 高性能文件查找/grep（`fff_find_files`/`fff_grep`/`fff_multi_grep`）                    | —          |

SQLite 结构化查询使用原生工具 `sqlite_query`，不是 MCP 服务器；源码构建时由同步脚本把 `seed/tool/sqlite.ts` 播种到 `~/.redcode/tool/`。

### 4.3 网络与视觉

| 服务器         | 用途                                                                                                                                         | 首次使用前 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Web Search** | 网页搜索：DuckDuckGo + Yahoo 兜底，内置服务，零 API Key                                                                                      | —          |
| **webqa**      | 浏览器自动化（Playwright）：observe 语义快照 + aria-ref 定位、坐标点击（canvas/自绘控件）、滚轮/悬停/多标签、元素级截图，做 Web 前端验证闭环 | —          |

### 4.4 记忆与进程

| 服务器               | 用途                                                                                                          | 首次使用前           |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| **su-prememory**     | 本机记忆库（SQLite + FTS5，即 `~/.redcode/supermemory.db`）。模板只向模型暴露 `list-memories`，用于分页列出全量做审计/清理；写入按 [6.2](#62-索引化与双写) 的文档优先规则，只有无权威文档承接的独立教训才入库；召回可直接用 `sqlite_query` 查库 | 本地记忆库与服务依赖 |
| **mcp-process-mgmt** | 管理交互式/长驻 shell 会话（REPL、dev server 等需要 stdin 的进程）                                            | —                    |

### 4.5 添加自己的 MCP

```jsonc
{
  "mcp": {
    "my-server": {
      "type": "local", // local = 本地进程
      "command": ["node", "./path/to/server.js"],
      "environment": {
        "API_KEY": "xxx",
      },
      "timeout": 30000, // 可选，默认 30s
      "enabled": true,
    },
  },
}
```

本地 MCP 也可以用 `npx`、`uvx` 等工具启动，或在 `~/.redcode/redcode.jsonc` 中添加永久配置。

---

## 5. AI 人格系统

### 5.1 工作原理

Soul 是助手身份的唯一来源，客户端只负责选择新会话的默认值：

1. **Soul Registry** 发现 `~/.redcode/souls/*.md`，解析身份元数据与人格正文。
2. **客户端偏好** 分别记住 TUI / GUI 上次选择的 Soul，只影响之后新建的根会话。
3. **会话绑定** 将 Soul ID 存入 `session.soul`；继续旧会话、fork 和子代理都保留原身份。

显示名、会话标题前缀与 commit 署名都来自所绑定的 Soul，不再根据 TUI / GUI 猜测。文件缺失或无效时会明确提示，并保留原绑定，不偷偷换成另一个人格。

### 5.2 选择 Soul

在 TUI 的 Code 会话中输入 `/soul` 打开选择器；如果知道 ID，也可以直接输入 `/soul karina`。

GUI 在 **设置 → 个性化 → Soul** 中选择新会话的默认人格。两端的偏好独立保存，已有会话显示自己绑定的 Soul。

**选择只影响后续新会话，当前会话保持原人格。** 旧 `/tui-persona`、`/gui-persona` 已弃用，不应再用来向当前会话手动加载另一份人格正文。

### 5.3 新增与编辑 Soul

在 `~/.redcode/souls/` 添加一个 Markdown 文件即可，不需要给客户端或核心代码增加人格分支。例如 `chi.md`：

```markdown
---
id: chi
name: 赤
display_name: 赤
commit_prefix: Chi
avatar: chi
description: 擅长简洁分析与清晰解释
---

# 赤

在这里写身份、语气与协作方式。
```

`id` 是唯一、稳定的小写标识，只允许字母、数字、`-` 和 `_`，且首字符必须是字母或数字。`name` 必填；`display_name`、`commit_prefix`、`avatar`、`description` 可选，`avatar` 只是资源键，`description` 是用于 `/soul` 选择器展示与搜索的简短单行说明，最多 256 个 UTF-8 字节。未填写时继续显示名称或 ID。Soul 不配置模型、权限、MCP 或执行策略；description 不会注入模型提示词。

每份文件上限 **16 KiB（UTF-8 字节）**，超限整份拒绝，不截断人格正文；无效文件或重复 ID 会显示问题，不影响其它有效 Soul。编辑文件不会热替换当前会话的快照，新会话才使用新正文。

首次启动自动补齐缺省模板。旧 `Tsoul.md` / `Gsoul.md` 迁移时保留原文件与正文；明显自定义的人格使用稳定的 legacy ID，不冒充官方人格，也不覆盖已有目标文件。

---

## 6. 记忆系统

### 6.1 概述

本节 6.1–6.4 描述 **Code 的工程记忆**。Chat 的个人档案与它独立，见 [6.5](#65-redspace-chat-个人档案)。

长期记忆由规则与 `memory` skill 引导 AI 维护，引擎负责加载已有的记忆文件，不会把每段对话自动提炼成长期教训。记忆分两层：

- **项目级** `.redcode/MEMORY.md`——当前项目的决策、踩坑与工作路标
- **全局级** `~/.redcode/MEMORY.md`——跨项目通用的历史教训

两层同时注入（全局在前、项目在后），不是二选一。

**Chat 不注入这两份工程记忆，也不加载项目 `AGENTS.md`。** 伙伴的身份、关系与个人资料来自 `~/.redcode/companions/<id>/` 下的档案，见 [6.5](#65-redspace-chat-个人档案)；引擎配置、MCP、普通技能与权限门控仍由两种模式共用。

> `~/.redcode/memory/` 下的旧当日日志已退役，历史文件保留可查，不再写入。

### 6.2 索引化与双写

记忆已索引化：MEMORY.md 只留**摘要与索引行**（主题 + 关键动作词 + 正文路径），完整正文优先写进项目 `.redcode/docs/` 或既有权威文档。只有**没有权威文档承接、又值得独立召回**的长期教训，才把全文存进本地记忆库 `~/.redcode/supermemory.db`（memories 表，project=global/项目名，FTS5），并在 MEMORY.md 留对应索引。不是每条记忆都必须入库；已有正文只更新文档和索引。

配套核对机制：

- 自检脚本 `bun ~/.redcode/scripts/check-memory-dualwrite.mjs`——核对全局 `#NN` 索引行与数据库全文，缺则列出
- 长期记忆只在本机维护，`MEMORY.md` 与 `supermemory.db` 不进入同步仓库；核对在本机运行
- 存量项目（正文还没有索引结构）不做一次性迁移，在该工作区整理记忆或收尾时**就地整理**：有效正文进文档，MEMORY.md 改成索引与工作路标

### 6.3 教训提炼

只有在出现值得长期保留的新教训、已确定的项目决策，或需要跨会话续接的工作状态时才整理；**普通问答和局部修复不触发记忆整理**。整理时 AI 按 `memory` skill 处理：

1. 审视当前项目的 `.redcode/MEMORY.md`，删掉已完成、过时的进度段，保留经验教训
2. 先写或更新完整正文：优先放项目 `.redcode/docs/` 或既有权威文档
3. 再在同一批更新 MEMORY.md 的索引与路标；没有权威文档承接的独立教训才全文入库，全局条目用 `#NN` 编号
4. 一条教训要升到全局，还要满足三个条件：换个项目仍然成立，忘掉它会付出明显代价，而且已有规则或技能没有覆盖。

全局记忆每轮都要付 token，只留值得长期持有的条目。进度正文放项目 `.redcode/docs/`，MEMORY.md 只留工作路标；参考文档同样放在项目 `.redcode/` 下，只留一句指针。

### 6.4 关闭记忆

两条 MEMORY.md 在 Code 中由引擎**固定注入**（`session/instruction.ts` 的 systemPaths 硬编码路径），没有官方开关；Chat 本来就不注入这两份。确实不想要的话：清空两份 MEMORY.md 内容，或改 `instruction.ts` 重新编译（不推荐）。

---

### 6.5 RedSpace Chat 个人档案

Chat 可以从第一句闲聊开始培养新伙伴，也可以接续已有伙伴。档案保存身份、关系、长期记忆、日记和可识别的旧对话文本；Code 继续按原有默认 Soul 和工作区运行。

**先把两种模式的边界分清：**

- 两种模式共用同一套全局 `redcode.jsonc`、MCP 配置、普通技能与权限体系；Chat 里发起的读写、命令同样受权限门控。
- Chat 主会话从绑定伙伴的档案读取个人资料，不加载 Code 的工程 `MEMORY.md` 和 `AGENTS.md`。`companion_memory` 只在绑定伙伴的主会话提供，不传给子任务。
- `session_query` 在 Chat 里只能查该伙伴自己的当前与历史主会话，不能扩大到别的项目或伙伴；在 Code 里默认只查当前工程。
- 档案目录不是普通项目工作区：引擎不会在 `~/.redcode/companions/<id>/workspace/` 下生成项目的 `.redcode/MEMORY.md`。

产品模式只有 Chat / Code，Plan / RedMind / Auto 仍是独立的执行权限选择。

#### TUI：导入与进入

```powershell
# 从 .openclaw 目录、其 workspace，或 ZIP 导入；路径包含空格时加引号
redspace companion import "D:\Archives\.openclaw.zip" --id qiuqiu --name "秋秋"
redspace companion list
redspace --companion qiuqiu

# 只续接这个伙伴最近的有效主会话
redspace --companion qiuqiu --continue
```

命令主名是 `redspace`，旧名 `redcode` 等价可用。从源码运行时用 `bun dev` 代替 `redspace`，参数照常追加（例如 `bun dev --companion qiuqiu`）。已进入本地 TUI 后，`/chat` 选择伙伴并续接会话，`/code` 选择开发工作区。Chat 中 `/new` 保留当前伙伴；`/soul` 不会改变伙伴身份或 Code 的默认 Soul。普通 `--continue` 只恢复 Code；`--session` 与 `--companion` 同用时必须匹配。远程 attach 暂不提供依赖本地目录切换的 `/chat`、`/code` 入口。

#### GUI：同一份档案

顶栏点 **Chat** 就可以开始和新伙伴聊天。已有个人档案可选择本地目录/ZIP，或输入服务端能访问的绝对路径，完成导入后开始聊天。连接远程服务时，浏览器所在机器的文件路径不代表服务器可访问；此时填写服务器上的路径。已有档案直接从列表选择。Chat 的新会话、关闭最后标签或归档当前会话都保留该伙伴；Code 的最近项目列表不混入个人档案目录。

TUI 与 GUI 连接同一个后端、使用同一个本机数据目录时，读取的是同一份档案和会话。不同机器或不同后端之间尚无自动同步。

#### 导入与续写的边界

默认位置是 `~/.redcode/companions/<id>/`：`source/` 保留本次选择导入的原文，`workspace/` 是可继续写入的个人档案，`profile.json` 记录绑定与来源。身份正文单独注册到 Soul Registry；长期记忆不塞进 Soul 文件。已有会话仍保留自己的 Soul 内容版本。

- 默认上下文有界加载 USER / IDENTITY、MEMORY 与最近两篇日记；需要更早个人资料时用 `companion_memory search/read`，日记未记录的旧聊天可在 `session_query` 可用时按同一伙伴范围检索。分页结果给出来源及续读位置。
- 新的共同经历、偏好与承诺通过 `companion_memory remember` 选择性追加到对应时区的当日日记，成功后才确认记住。它遵守读取/编辑权限与用户不希望保存的意图；不会无条件把每轮原文复制进个人日记。普通会话仍按原有 Session 机制保存。
- 在同一伙伴的新会话里，第一句话可以接上上次没写进日记的几句对话。聊天时出现与旧日记相近的用词，伙伴也可能自然想起其中一小段。用户亲口表达的长期偏好或纠正，可以通过 `companion_memory retain` 带日期和出处存进该伙伴的 `MEMORY.md`。
- 在 GUI 设置中打开伙伴的 **记忆 → 查看详情 → 日常记录**，可以翻阅日记，默认显示最近一篇。新建和导入的伙伴都在聊天时选择性记录日记。
- 以同一来源重新导入会补入缺失的派生聊天历史，不覆盖现有 Soul 或之后新增的日记。同 ID 的不同档案返回冲突，需改用新 ID 或先人工整理；不自动合并两个有分歧的档案。
- 导入说明会列出异常编码等问题。源文件保留；不能可靠解码的内容不会被伪装成有效记忆。
- 旧 AGENTS、技能和机制文件仅保留为来源或可读资料；旧渠道 token、设备密钥、网关认证、绝对路径和运行任务不被激活。导入时还会从同一 OpenClaw 身份的 JSONL 中提取可识别的用户/伙伴文本，保存为带来源信息的派生资料供按需检索；原始 JSONL 不会还原为可继续的完整旧会话，工具载荷也不导入。轨迹、梦境、心跳和 cron 调度仍未接入。导入成功不等于完整旧运行时迁移完成。
- Chat 不因全局 Code 自动分享配置而被自动公开；显式分享仍沿用现有功能。个人档案与来源文件不应加入项目代码仓库。

当前 CLI 主名 `redspace`，`redcode` 与 `~/.redcode/` 路径保留用于兼容既有安装。

---

## 7. 配置详解

### 7.1 配置文件层次

按加载顺序排列，**后加载的覆盖先加载的**：

| 文件                             | 作用域              | 说明                                                                                                                                    |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.redcode/redcode.jsonc`       | **全局** — 所有项目 | 通用 provider、MCP、权限规则                                                                                                            |
| `~/.redcode/redcode.local.jsonc` | **全局 · 仅本机**   | 机器本地覆盖层，优先级高于上一行。放绝对路径、按显存挑的模型档位这类因机而异的值；多机同步时把它 gitignore 掉，见 [10.2](#102-多机同步) |
| 项目根 `redcode.jsonc`           | **项目级**          | 覆盖或补充全局配置                                                                                                                      |
| 项目内 `.redcode/redcode.jsonc`  | **项目级**          | 同上；会从当前目录逐级向上查找到 worktree 根，适合放在子目录里做局部覆盖。同目录下的 `redcode.local.jsonc` 同样生效且优先级更高         |

其余全局资源（不是配置文件，但同样从 `~/.redcode/` 读）：

| 路径                                    | 内容                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `~/.redcode/MEMORY.md`                  | 长期记忆，AI 自动读写                                                  |
| `~/.redcode/souls/*.md`                 | Soul 元数据与人格正文，按会话保存的 Soul ID 注入                       |
| `~/.redcode/skill/` `command/` `agent/` | 全局技能、斜杠指令、子代理定义（`agent/` 与 `agents/` 两种目录名都认） |
| `~/.redcode/plugin/` `themes/`          | 全局插件与自定义主题                                                   |

> 配置合并规则：深合并，项目级覆盖全局级，`instructions` 数组拼接而非替换。
> 注意 `redcode.local.*` 只由人手写——引擎自身写回配置（例如在界面里切主题）落在 `redcode.jsonc`，不会污染本地层。

### 7.2 权限门控

权限门控由**代码强制层**（doom_loop 检测，服务端拦截）兜底，配合默认规则、配置中的 `permission` 与各 agent 的规则工作。内置子代理定义随程序编译，自定义子代理可放在 `~/.redcode/agent/`。

`ask`、`allow`、`deny` 分别表示询问、放行、拒绝；工具调用权限接口不代表一定弹窗，命中 `allow` 时会直接执行。例如，想让历史会话查询先询问，可以配置：

```jsonc
{ "permission": { "session_query": "ask" } }
```

`session_query` 默认只查当前工程的其它会话，显式指定 `directory: "*"` 才会跨工程。这个参数只是查询范围，不是用户授权；历史内容也不构成当前操作的授权。

#### 代码强制层（防空转，软硬双层）

**软层——递进提醒**（`session/repeat-tool-reminder.ts`）：同一工具+同一参数连续调用 3 / 5 / 8 次时，把 `[System notice]` 提醒贴在该次结果尾部让模型自纠——不打扰你，纯建议。轮询类调用（每次输出在变）只会触发这层。`todowrite`/`todoread` 这类记账工具不计数也不打断计数。

**硬层——权限弹窗**（`processor.ts` doom_loop 检测），自动检测两种模式：

1. **精确重复**：同一工具+同一输入连续 3 次，且至少一次报错，或输出也完全相同（全成功的原地空转）
2. **周期循环**：6 步内形成 A→B→A→B 或 A→B→C→A→B→C 模式，且至少一次报错

检测触发时向用户提示确认，防止 AI 无意识空转。默认配置 `doom_loop: "ask"`。

### 7.3 繁忙时消息送达（busy_enter）

AI 正在干活时你发的消息怎么处理，`redcode.jsonc` 顶层 `busy_enter` 二选一：

```jsonc
{
  // "steer"（默认）：插话——消息在下一个工具调用结束后立刻送达模型，
  //   适合中途纠偏（"别改那个文件"），不用等本轮跑完
  // "queue"：排队——消息对当前轮完全隐藏，本轮结束后自动作为新一轮的输入，
  //   适合攒任务（"下一件事做 X"），不打断当前思路
  "busy_enter": "steer",
}
```

**TUI 和 GUI 都可以直接 `/busy-enter` 切换**（命令面板同样可搜"繁忙时消息"），**GUI 还可以在 设置 → 通用设置 → 繁忙时消息送达 下拉切换**。三个入口都走 API 写回 `redcode.jsonc` 并强制重载配置，**立即生效不用重启**；手改配置文件则需重启。

排队消息由服务端持久化，重启后仍可恢复：TUI 用 `/pending` 逐条送达、编辑或取消，GUI 在排队消息上直接操作。TUI 的 `QUEUED` 徽标表示消息尚未装配进模型上下文，不等于消息已丢失。

### 7.4 归档会话（仅 GUI）

会话列表太长时，把做完的会话**归档**——它从首页列表消失，但**数据一个字节都不删**（只是打了个时间戳，列表查询默认过滤掉带时间戳的）。

| 操作       | 位置                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 归档       | 首页会话行/看板卡片 **右键 → 归档会话**；或命令面板 `session.archive`；或 `Ctrl+Shift+Backspace` |
| 查看已归档 | 首页搜索框右侧的**归档图标**按钮，切换后列表显示已归档会话                                       |
| 取消归档   | 在已归档视图里 **右键 → 取消归档**，会话立刻回到正常列表                                         |

> 归档不省磁盘（消息和历史都还在库里）。想真正释放空间只能删会话，那是不可逆的。

### 7.5 添加自定义 MCP

见 [第 4.5 节](#45-添加自己的-mcp)。

### 7.6 上下文用量：在哪看、怎么读

| 界面 | 位置                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| TUI  | 侧边栏 **Context** 块（常驻）                                                                              |
| GUI  | 输入控件行里模型名旁边的**圆环**；悬浮看用量，点击弹出**精简会话**确认窗。详细账本从右侧「上下文」入口打开 |

两边都显示：当前占用 / 模型标称窗口 · 占用率、会话累计、解码速率与首字延迟、in/out/思考
token、缓存读写与命中率、花费。

**颜色按绝对上下文用量提示，不按百分比，也不代表正在执行某种压缩操作。** TUI 侧边栏与 GUI 圆环使用同一组档位：

| 颜色 | 上下文用量 |
| ---- | ---------- |
| 绿   | < 320k     |
| 黄   | 320k–360k  |
| 橙   | 360k–400k  |
| 红   | ≥ 400k     |

原生自动压缩开启时，模板的 `compaction.native.trigger_tokens` 为 400k，实际触发还受模型可用窗口限制。模板的 `compaction.prune` 已关闭，不能把橙色理解成“已经开始裁剪工具结果”。

日常可主动精简：TUI 用 `/compact`（别名 `/summarize`）或按 `<leader>c`；GUI 点击圆环会先弹出确认，再发起压缩。用量数字仍以模型标称窗口为分母显示，与颜色档位分开读取。

**解码速率与首字延迟是两回事，所以分开显示。** `52.4 tok/s · 首字 2.3s`——首字慢是排队与
预填（供应商侧负载、上下文长度），解码慢是吐字本身。合成一个「总速度」会让这两种完全不同
的问题看起来一样。

#### GUI 上下文标签页里有两块拆分，别混

| 块             | 数据来自                               | 覆盖范围                                              |
| -------------- | -------------------------------------- | ----------------------------------------------------- |
| **真实构成**   | 服务端在请求**真正发出的那一刻**记的账 | 系统提示 / 工具定义 / 对话，工具定义还列出最贵的 8 个 |
| **上下文拆分** | 客户端按字符数估算                     | 只有消息——**看不到系统提示与工具定义**                |

差别不是精度是范围：系统提示与工具定义这两块从来没到过客户端，估算器手里根本没有这份数据，
而它们恰恰是前缀里最大且最不透明的部分。想知道「哪个 MCP 挂上来悄悄吃掉几千 token」，看
**真实构成**里的工具定义那一列。

真实构成只留最后一轮、只在服务端内存里。会话在本次启动后还没发过请求时显示「暂无」，下一轮
请求后就有了。

#### 回复被砍断时会有标记

回复末尾出现 **输出被截断（达到 token 上限）** 时，说明模型撞到单次输出上限被切断，不是话
说完了——TUI 显示在消息尾行（警示色），GUI 是一条分割线。

---

## 8. 内置命令

以下包含内置入口和随仓库播种的命令；客户端差异在表内注明：

| 命令               | 作用                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `/goal <目标>`     | 钉住会话目标，防止 AI 跑题（见 [8.1](#81-钉住的目标钉了之后在哪看)）                                |
| `/goal clear`      | 清掉当前目标                                                                                        |
| `/goal done`       | 标为完成，自动归档教训                                                                              |
| `/soul [ID]`       | 在 TUI 的 Code 会话里选默认 Soul：省略 ID 时打开选择器，指定 ID 时直接选择。只影响新会话，见 [5.2](#52-选择-soul) |
| `/chat`            | 选择并进入一个伙伴的 Chat，续接该伙伴的会话（TUI）                                                  |
| `/code`            | 选择开发工作区，回到 Code（TUI）                                                                    |
| `/new`             | 新建会话；在 Chat 里保留当前伙伴                                                                    |
| `/recall <关键词>` | 按关键词从本机的工程记忆库（`supermemory.db`）查找历史教训                                          |
| `/subtask <任务>`  | 在隔离子会话中执行子任务，上下文隔离不污染当前会话（父流程等待结果）                                |
| `/commit`          | 按 conventional commit 格式提交代码                                                                 |
| `/changelog`       | 生成 CHANGELOG.md 条目                                                                              |
| `/issues`          | 查看或创建 GitHub issues                                                                            |
| `/learn`           | 从当前会话提取非显而易见的教训写入 AGENTS.md                                                        |
| `/translate`       | 把改动的英文文档/UI 文案翻译成其他语言                                                              |
| `/rmslop`          | 清理本分支引入的 AI 代码痕迹（多余注释/防御性代码等）                                               |
| `/spellcheck`      | 检查改动的 Markdown 文件拼写和语法                                                                  |
| `/ai-deps`         | 排查 AI SDK 依赖可升级的 minor/patch 版本                                                           |
| `/lan`             | 打开或查看手机（局域网）远程访问入口                                                                |
| `/busy-enter`      | 切换繁忙时消息送达：插话 ↔ 排队（TUI/GUI 均内置，立即生效，见 [7.3](#73-繁忙时消息送达busy_enter)） |
| `/compact`         | 发起精简会话：TUI 用 `/compact`（别名 `/summarize`）或 `<leader>c`；GUI 点击上下文圆环（先确认）     |
| `/pending`         | 管理排队消息，逐条送达、编辑或取消（TUI；GUI 在排队消息上直接操作）                                 |

命令文件位于 `seed/command/` 和 `~/.redcode/command/`，纯文本，可以自己添加或修改；`/soul`、`/chat`、`/code`、`/new`、`/busy-enter`、`/compact`、`/pending` 是内置入口，不在命令文件里。

### 8.1 钉住的目标：钉了之后在哪看

目标不是纯 prompt 引导，是落库状态——钉住之后每轮都会注入系统提示，直到 `/goal done` 或
`/goal clear`。落库依赖 `goal_set` / `goal_done` / `goal_clear` 三个工具，而它们默认关闭：
需要环境变量 `REDCODE_ENABLE_GOAL_TOOLS=true`（不是配置文件项）。工具没开时 `/goal`
仍会把目标写进本轮提示词，但不会持久化，换会话/重启就丢。

| 界面 | 位置                     | 显示什么                           |
| ---- | ------------------------ | ---------------------------------- |
| TUI  | 侧边栏，Todo 上方        | 目标原文 + 状态 + 该目标已用 token |
| GUI  | 侧栏 **Plan** 标签页顶部 | 同上                               |

状态有五种：**进行中 / 已完成 / 受阻 / 预算用尽 / 已清除**。清除后这块整个消失。

开了自动续跑（`experimental.goal_auto_continue`，默认关）之后会多一条预算进度：
`已用 / 预算 · 自动续跑第 n/20 轮`。**没开的时候只显示已用量、不显示分母**——20 轮上限与
预算天花板只在自动续跑开着时才真的会拦人，关着还画进度会让人以为有个并不存在的限制在逼近。

预算默认 200k tokens，改 `experimental.goal_token_budget`。用超了会自动标成「预算用尽」并让
AI 收尾。

---

## 9. Skill 技能系统

Skill 是扩展 AI 行为的机制——本质上是注入给 AI 的指令文件。

### 9.1 内置 Skill

| Skill                        | 作用                                                                     | 触发词                     |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| **memory**                   | 记忆的写与剪：双层 MEMORY.md 注入 + 文档优先/索引 + 剪枝阈值            | "整理记忆""记忆太长了"     |
| **ce-code-review**           | 结构化多维度代码审查                                                     | "帮我看看代码""review一下" |
| **diagnose**                 | 形式化 bug 诊断循环                                                      | "查bug""排查一下""debug"   |
| **tdd-flow**                 | 测试先行、假阳性过滤与置信度门控，已整合原 defensive-agent               | "认真做""用 TDD""别乱改"   |
| **goal-automation**          | 检测大任务并建议钉住目标                                                 | 自动检测                   |
| **gui-regression**           | 用 webqa 实测长会话、流式输出、IME、分页与面板拖拽                       | GUI 改动后的定向回归       |
| **frontend-design**          | 生成 macOS 风格的高质量前端界面，避免 AI 通用观感                        | "做个页面""写个组件"       |
| **simplify**                 | 检测过度工程，建议精简                                                   | "太复杂了""精简一下"       |
| **red-scribe**               | Red 的写作风格与中英去 AI 味，已整合 yuqi-slop、stop-slop                | "按我的风格写""去AI味"     |
| **effect**                   | 在本仓编写与调试 Effect v4 代码（service / layer / Schema / 类型化错误） | 写或调 Effect 代码时       |
| **harmonyos-android-compat** | Android 应用移植/验证到华为鸿蒙（HarmonyOS 6+、卓易通）                  | 鸿蒙移植与兼容验证时       |
| **security-audit**           | 面向代码库、API、CLI 与服务的安全审查和漏洞排查，按请求强度分级执行      | "安全审计""漏洞审查""渗透测试" |
| **visual-prototype**         | 先做可编辑的 HTML 视觉原型，再按稿实现                                   | "做个 HTML""开个网页""照这份 HTML 做" |

上表中的技能随仓库分发，完整文件在 [seed/skill/](seed/skill/)。首次启动找到种子目录时，程序会把缺少的技能复制到 `~/.redcode/skill/`，不会覆盖已有的同名技能。

下面这些只存在于维护者本机的 `~/.redcode/skill/`，**不在仓库里**，克隆的人不会有——举例说明个人库可以怎么扩展（**不是全量清单**，个人库随维护者习惯持续增删）：

| Skill                   | 作用                  | 触发词              |
| ----------------------- | --------------------- | ------------------- |
| new-project             | 新项目脚手架          | "新项目""搭个项目"  |
| bump-version            | 一键升版              | "升版""bump""放版"  |
| config-edit             | 安全修改 RedCode 配置 | "改配置""加 MCP"    |
| technical-documentation | 构建与检查技术文档    | "写 README""审文档" |

### 9.2 添加自定义 Skill

```powershell
New-Item -ItemType Directory -Force "$HOME\.redcode\skill\my-rules" | Out-Null
notepad "$HOME\.redcode\skill\my-rules\SKILL.md"
```

SKILL.md 需要 YAML frontmatter（`name` + `description`），引擎靠 description 语义匹配自动触发：

```markdown
---
name: my-rules
description: 我的编码规范。用户说"按规范来""检查规范"时触发。
---

# 我的编码规范

- 所有函数必须有 TypeScript 类型注解
- 使用 `const` 而非 `let`
- 避免 `any` 类型
- 行尾不要分号
```

**无需在 `redcode.jsonc` 中注册**——引擎自动扫描 `~/.redcode/skill/` 下所有 `SKILL.md`，重启对话即生效。

---

## 10. 隐私与多机同步

### 10.1 隐私模型

```
仓库（公开）                   用户本地（私有）
seed/                          ~/.redcode/
├── skill/           ← 种子     ├── souls/*.md         ← 你的人格（karina / yuqi，首启由内嵌模板播种）
├── command/         ← 种子     ├── MEMORY.md       ← 你的记忆
├── tool/sqlite.ts   ← 种子     ├── supermemory.db  ← 无文档承接的独立教训全文
├── scripts/         ← 种子     ├── skill/ command/ agent/
└── redcode.home.jsonc ← 配置模板 └── data/           ← 会话 DB / 日志 / 快照

（seed/ 是播种源，不是项目配置目录；技能首启播种见第 1 节，其余共享资源由 script/sync-home.bat 同步。
　人格与 MEMORY 模板已内嵌进二进制，见 packages/redspace/src/project/template/）
```

内置子代理（explore/execute）定义在 `packages/redspace/src/agent/definition/`，构建时内联，不复制到用户目录；自行编写的 `~/.redcode/agent/*.md` 仍可使用。

克隆 RedSpace 源码不会复制你的本机配置或历史会话。`~/.redcode/` 独立于源码仓库；其中的 `companions/` 还可能保存伙伴日记和导入的旧对话，不要把它当作可分发的模板。

### 10.2 多机同步

多台电脑可以用自己的**私有仓库**共享选定的 Soul、技能、命令、插件及不含密钥的配置。工程记忆、伙伴档案、会话数据和本机凭据留在各自的电脑上。

在 `~/.redcode/.gitignore` 中加入以下规则。如果文件已经存在，合并规则，不要覆盖原文件：

```gitignore
data/
companions/
cache/
state/
locks/
node_modules/
MEMORY.md
MEMORY-archive.md
supermemory.db*
memory/
backup/
scripts/
temp/
redcode.local.json
redcode.local.jsonc
```

**第一台电脑**：如果 `~/.redcode/` 还不是 Git 仓库，可以这样开始。下面只选一个你愿意共享的 Soul 作为示例：

```powershell
cd ~/.redcode
git init -b main
git add -- .gitignore souls/karina.md
git diff --cached
```

确认暂存内容不含密钥或私人对话后，在 GitHub 上创建一个空的 **Private** 仓库，再提交并推送：

```powershell
git commit -m "Add shared RedSpace settings"
git remote add origin (Read-Host "粘贴私有仓库的 Git 地址")
git push -u origin main
```

已有配置仓库就沿用原分支和远端，不必重新初始化。以后也按文件名暂存，不要整目录添加；`.gitignore` 不能排除已经被跟踪的文件。

**第二台电脑**：如果 `~/.redcode/` 尚不存在，在用户主目录用 `git clone <私有仓库地址> .redcode` 克隆。若目录已有配置，先克隆到别处，再合并想共享的文件，不要覆盖旧档案。同步个人配置不需要向 RedSpace 源码仓库推送。

#### 机器本地覆盖层（避免两台机器来回改）

MCP 程序的绝对路径和按显存选择的模型可能每台电脑都不同。这类设置写在 `~/.redcode/redcode.local.jsonc`。它覆盖全局 `redcode.jsonc` 中的同名设置，不随私仓同步：

```jsonc
// ~/.redcode/redcode.local.jsonc —— 只在这台机器上生效
{
  "$schema": "https://redcode.dev/config.json",
  "mcp": {
    "indexgraph": {
      "type": "local",
      "command": ["node", "D:/AI/IndexGraph/mcp-server.js"], // 换台机器路径就不同
      "enabled": true,
    },
  },
}
```

共享配置里只留换台机器仍能使用的设置，例如权限规则。API 密钥即使两台机器都要用，也不要写进同步文件。

### 10.3 跨平台注意事项

RedSpace 目前主要在 Windows 10/11 上开发和测试。跨平台兼容性问题欢迎提交 PR。

---

> 如有其他问题，请查看 [CHANGELOG.md](CHANGELOG.md) 了解版本历史，或提交 GitHub Issue。
