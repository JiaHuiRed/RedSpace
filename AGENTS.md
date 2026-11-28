# 边界

本文件记录 RedSpace 的项目路由、构建与验证、模型上下文、版本与代码规范。

# 项目路由

| 目录 | 职责 | 包级指南 |
| --- | --- | --- |
| `packages/redspace/` | 共享执行核心、TUI、CLI、plugin、MCP、Effect、session | `packages/redspace/AGENTS.md` |
| `packages/desktop/` | Electron GUI、main/renderer、sidecar | `packages/desktop/AGENTS.md` |
| `packages/app/` | SolidJS Web UI、组件、路由、i18n | `packages/app/AGENTS.md` |
| `packages/plugin/` | Plugin SDK 类型定义 | — |
| `seed/` | skill、command、agent、配置与工具的种子目录 | — |

改动 package 前先读对应的 AGENTS.md；包级规则补充并优先于根目录的代码细节。

`seed/` 由 `script/sync-home.bat` 同步到 `~/.redcode/` 后生效：

- `seed/scripts`：由 `sync-home-scripts.bat` 镜像同步，以 seed 为准；仅修改 home 中的脚本会在下次构建时丢失。
- `seed/{skill,command}`：seed-only，已有同名文件不覆盖；修改 seed 后，本机已有版本需另行同步。
- `seed/tool`：只同步 `sqlite.ts`。

# 构建与验证

- **类型检查**：在实际受影响的 package 目录运行 `bun run typecheck`。核心包使用 `script/typecheck.ts`，内存不足或 tsgo 崩溃时回退 TypeScript 5.x。
- **单测**：从 package 目录运行，使用完整文件路径过滤，避免触碰 live 配置。核心包的 `bun test` 加 `--timeout 30000`；各包的测试与构建命令见包级 AGENTS.md。
- **子进程超时**：新增 `appProcess.run` 调用须显式传入 `timeout`，无需超时的调用在上一行注明 `// subprocess-timeout: none — <理由>`。门禁：`bun run check:subprocess-timeout`（pre-push）。
- **HTTP API 覆盖**：新增端点在 `httpapi-exercise` 补对应场景；coverage 模式核对路由与场景（pre-push）。
- **OpenAPI 与 SDK**：修改进入 OpenAPI 的 schema 出口（如 `packages/redspace/src/config/*.ts`、`session/status.ts`），commit 前运行 `bun run check:openapi-drift`。如有差异，在仓库根目录依次运行：
  ```bash
  bun ./packages/sdk/js/script/build.ts
  bun run gen:openapi
  ```
  两条命令分别更新 SDK 与仓库的 OpenAPI；`script/generate.ts` 会触发全仓 prettier `--write`。

## 按改动面验证

同包相关改动合并验证，已通过且输入未变的检查不重跑。

| 改动 | 验证 |
| --- | --- |
| 生产 TS 实现或类型、纳入 tsconfig 的测试类型与服务装配 | 对应 package 的 typecheck |
| 行为、测试 | 对应测试文件 |
| 提示词、模型可见内容 | 对照该模型的实际会话 |
| 版本号、徽章、发布清单 | `script/check-version-consistency.ts` |
| 构建路径 | 对应 package 的 build |

仅改测试样例或断言无需额外 typecheck；`packages/app/e2e/` 与 `packages/desktop/src/**/*.test.ts` 不在各自默认 typecheck 范围内。全量套件仅在用户要求或改动涉及全仓时运行。

## 核心包测试 lane

在 `packages/redspace/` 下运行：

| lane | 命令 | 用途 |
| --- | --- | --- |
| unit | `bun run test` | 全量单进程顺序跑；排查全局态污染前用 `bun run script/lane-inventory.ts` 更新进程绑定文件清单 |
| httpapi | `bun run test:httpapi` | 真服务器 coverage / auth / Effect；非 CI 且内存不足 32GB 时全量 Effect 跳过，可用 `script/httpapi-exercise.ts --mode effect --include <名>` 定向运行 |
| 套件计时 | `bun run bench:test` | 全套件耗时，见 `perf/test-suite.md` |
| 逐文件 profiler | `bun run profile:test` | 慢测试定位，支持 `TEST_PROFILE_GLOB` |
| 性能预算 | `bun run bench:budget` | `filterCompactedEffect` 预算门禁，隔离临时 DB，先跑正负控制自检 |

# 本仓工程原则

- **函数家族对齐**：修改同族函数时核对所有同形状兄弟函数，避免遗漏和无意的不对称。
- **配置报错要响**：在加载时或最早可解析处报告误配置，无法解析的引用显式报错。
- **按需 diagnose**：未知根因、回归、跨模块或时序异常、同方向连续失败、高风险行为变化或证据不足时加载 diagnose skill；根因明确的局部问题直接修改并验证。
- **复杂度有成本**：增加推测性防御前，说明失败模式、概率与成本并征得同意。未知值在拥有方边界校验一次，内部依赖已建立的类型与契约。
- **配置归属清晰**：已有用户配置契约或需跨部署调整的值，归入拥有方的配置入口并复用校验；内部策略和局部默认值保持简单。

# 模型上下文

新增模型输入复用现有有界诊断与请求证据，记录来源、版本、大小及装配位置，秘密不进入明文日志。如诊断样本无法完整还原请求，明确其覆盖范围。

模型可见改动须在 commit 正文写明『四问』并逐项回答。

1. **模型看到什么变了**：列出增删或移动的段落，给出原文对照。
2. **Token 影响**：固定前缀增减多少，可用 `session/prefix-shape.ts` 测量。
3. **KV Cache 影响**：从哪一段起前缀失效，还是完全不动。
4. **注入上限**：进入上下文的数据须有确定的字节或 token 上限；单项超过 1K token 在 commit 中点名，超过 10K 说明为何不能截断。

运行时保持稳定装配顺序。版本化修订直接合并、移动或删除段落，在发布说明记录最早变化位置和一次性缓存重建影响。

# Git、版本与决策记录

- **Commit scope**：按改动所属包或领域取值，常用 `core` `redcode` `tui` `app` `desktop` `ui` `sdk` `plugin` `seed` `notes` `agent` `skill` `mcp` `config` `prompt` `session` `tool` `provider` `script` `ci` `changelog` `version`。
- **版本与文档**：维持单一版本线，按 bump-version skill 或 CHANGELOG 顶部说明与 `script/check-version-consistency.ts` 升版；收编 `[Unreleased]`，用 `git log <上一版 bump>..HEAD` 逐条核对，并打本地 annotated tag `v<版本号>`。版本号、徽章、CHANGELOG、README 可直接修改。
- **决策记录 `docs/notes/`**：遵循目录 README 的规则。遇到代码回链时查阅对应决策；写新 note 或调整历史决策前用 `ls docs/notes/*/` 查重；落地后在对应代码头注释或 CHANGELOG 中回链。

# 代码风格

- 优先类型推断、Bun API、函数式数组方法、`const` 与 early return。
- 主函数呈现 happy path，辅助函数表达真实概念，单次使用的简单值直接内联。
- 尽量避免 `any` 与 `try/catch`；`try` 只包可能抛错的语句，空 `catch` 注明吞掉的错误与理由。
- 测试实际实现，尽量少用 mock。
- 仅在有长期解释价值时写 `// YYMMDD Red xxx`，保留已有有用注释。
