# Prompt Pin 消息快照：冷恢复不重放插件改写

状态：implemented

## 问题

0.19.1 综合审计 F-07：msgPin 与插件消息变换的稳定性。

`_caches.msgPin` 只在进程内存里钉住已发送消息的 parts，`PromptPin` 落盘只存 tools/mcpGuide。冷恢复（重启续接、模型切换、进程缓存被回收）后 msgPin 为空，历史消息重新走 `experimental.chat.messages.transform`；而插件注入非幂等——memory-recall 按会话 seen 去重，检索结果随记忆库变化。同一条消息两次 pin 得到不同内容，前缀从改写点起整段失效。

实测证据（`~/.redcode/data/log/2026-11-17T182530.log` 与 `185230.log`）：同一个 `msg.id` 在两个进程里各 pin 一次，长度 `1776` 与 `80`——一个是"原文 + 检索块"，一个是原文。审计另记 15:02 两个会话同时整段 miss。

## 决策

把已钉住消息的 parts 快照一起落盘，冷恢复优先复用：

- `PromptPin.VERSION` 2 → 3，`Pin` 增加 `messages`（按消息 ID 索引的 parts 数组）与 `nativeRevision`。旧 pin 靠版本号整体弃用重建，与 v1→v2 同一机制。
- 冷恢复灌入：`_caches.msgPin` 缺失时读盘，`nativeRevision` 不匹配则不灌入（native compaction 版本变了，旧快照作废）。只在缓存缺失时读盘，热路径零额外 IO。
- 增量落盘：本轮有新钉住消息（`cached > 0`）才写，写在 mcpGuide 可用的位置，避免用 `undefined` 覆盖文件里已有的 guide；tools 缓存缺失时跳过，下轮冷组装补写。
- `PromptPin.dropMessages`：compaction 结算只丢消息快照，tools/mcpGuide 继续复用。`settlePromptCaches` 里同步调用——压缩改写必须在下一轮生效，快照留着会被钉回去，压缩白做且可能撑爆上下文预算。

## 取舍

- **检索新鲜度让位于前缀稳定**：冷恢复后模型看到的是上次注入的旧记忆块，不重新检索。想刷新等 compaction 或新会话。这是本决策的核心交换，不是疏漏。
- **消息快照上限 512 KiB/会话**。整份序列化消息映射计入预算，超限的单条直接跳过。优先按历史顺序保存插件和运行时提醒改写后的 parts，剩余空间保留近期消息。数据库可重建普通正文，早期改写丢失会打断其后的缓存前缀。
- **删除会话清理**：用户主动删会话走 `Session.remove`，不经 evictor 的 `dropSession`，pin 文件（v3 起含完整私人对话 parts）会残留直到 prune（每 200 次 save 且 >500 份才触发）。261118 在 `Session.remove` 里与 `session_diff` 并列调 `PromptPin.drop`，删除即清；`drop` 失败留孤儿无害（同 id 未来 save 会覆盖）。
- 快照按消息 ID 覆盖内存里的 parts，不做合并：与既有 pin 循环的"整条替换"语义一致，字节序不会因为拼接而改变。
- 插件若改写 assistant 消息，快照同样覆盖（落盘的是全部已钉消息，不筛选角色）；不与任何单一插件行为耦合。

## 模型可见四问

1. **模型看到什么变了**：正常运行路径无变化。冷恢复/模型切换后，历史 user 消息复用上次钉住的 parts（含插件注入块），不再重新 transform 出新的检索结果。
2. **token 影响**：固定前缀不变（本决策的目标就是让它不变）。冷恢复场景下历史消息的 token 数与上次发送时相同；对比修复前，省掉的是整段前缀重建（实测案例 321k token 全价）。
3. **KV cache 影响**：核心收益。修复前从改写点起前缀全部失效；修复后冷恢复的首请求可以直接命中上次的缓存前缀。
4. **上限**。消息快照 512 KiB，系统段快照 256 KiB。磁盘文件数沿用 `DISK_MAX = 500` 和 `PRUNE_EVERY = 200` 修剪。

## 2026-11-22 重启续接

同一会话、同模型在重启前后的系统段取同一份环境、指令与技能快照。新会话、不同模型首次组装、安装版本、工作目录、会话模式或显式指令配置变化均重新组装。日期和伙伴档案原有刷新规则继续执行。系统快照超过预算时回退到实时组装，保持指令完整。

旧 v3 文件仍可读。已有消息快照第一次被使用时，对照本轮的数据库投影补记改写优先级。先前已被裁掉的改写无法从旧文件恢复。系统、工具和消息用同一次原子文件替换落盘。压缩结算清掉消息快照和改写标记，系统快照与工具定义继续复用。

`prompt-pin-restart.test.ts` 通过两个真实后端进程共用隔离数据库，验证修改 `MEMORY.md`、历史正文超过 512 KiB 后，重启续聊的既有出站消息逐字相同，工具定义与模型相同。新会话读取新版记忆。

## 验证

- `prompt-pin.test.ts` 验证消息快照往返、历史改写优先级、超限跳过、旧格式兼容，以及 `dropMessages` 保留系统段和工具定义。
- `prompt.test.ts` 新增端到端回归：非幂等 transform 在"第二个进程"注入不同内容（`[RECALL:1]` → `[RECALL:2]`），模拟冷恢复（同时清 `msgPin` 与 `modelMsgs`）后断言历史里那条消息的字节与首次发送完全一致。
  - 反向验证：临时置空 seed 后测试转红（`first question[RECALL:1]` → `first question`），恢复后转绿。只清 `msgPin` 不清 `modelMsgs` 会造成假绿——这是本轮实测踩到的坑。
- 全套件：`prompt.test.ts` 128 项（116 pass / 12 skip / 0 fail）；`prompt-pin.test.ts` + `prompt-caches.test.ts` 35 项全过；redspace typecheck 通过。

关联：[审计报告](../../../reviews/0.19.1-comprehensive-audit.md) §8。
