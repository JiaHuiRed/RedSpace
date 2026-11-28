# 固定前缀减重：工具说明、tdd-flow 与 WORK_RULES 收口

状态：implemented

## 问题

工具定义在固定前缀里每轮计费，而其中多份描述在重复讲同一件事：

- `skill` 把"载入/匹配/注入/返回"说四遍，静态 `skill.md` 与运行时 `describeSkill()` 各讲一份；
- `todoread` 把"恢复任务状态"拆成五个并列场景；
- `edit` 给了 hashline 语法，又给缩进例子，再解释一遍缩进，`input` 参数描述里还复述一次；且 hash 不匹配的文案写"re-read"——而 `edit.ts:607` 的回包本就带当前内容和新 TAG 并明说不要先 read，旧文案白让模型多跑一次读；
- `read`/`glob`/`grep`/`write` 含 schema 已表达的参数说明与泛化开场。

同类冲突还有三处：`todowrite` 要求"三步以上主动用、疑则必用"，`default.md` 却写"小型/中型工作跳过"；`tdd-flow` 把"认真做/严格点"列为触发，正文里测试先行同时是"底线"和"默认建议"；`WORK_RULES` 尾段与 `default.md` 的执行纪律同义，却挂在 system 最末尾重复一遍。

## 决策

- 八份工具说明按"保留判断、删掉重复"重写，合计约 2452→1043 token（字符数/4 估算）。`edit` 留一个同时展示 TAG、行范围、缩进的例子加紧凑操作清单，保住分隔符计数、单行替换、多操作同基准行号、两种模式参数。
- `describeSkill()` 只留名字来源与名字表；名字表保留，因为 `<available_skills>` 超限会尾部截断，名字表是兜底。
- `todowrite` 改为"是否需要持续跟踪"，与 `default.md` 同界，删步数阈值与"疑则必用"。
- `tdd-flow` 触发限定为明确要求 TDD 或主动选择，删重复写全代码、无条件二审、机械打分与互相抵消的条款；seed 与 live 双仓同步。
- 主 Code 不再注入 `WORK_RULES`，仅子任务（`parentID`）保留；`prompt-eval` 的 runtime 臂留作 legacy 对照。
- 退役四个私仓插件：CORE 注入器（AGENTS 无标记）、local-stats（无读取方）、mcp-gate（按工具名误提醒）、tool-trim（按长度误剪原生契约）。

## 备选与否决理由

- **只在运行时裁剪工具描述（保留 tool-trim）**：否决——判据 `id.includes("_")` 认的是名字形态，而真 MCP 工具在后续装配阶段加入、不经过该 hook。实测被剪的是 `apply_patch` 1098→594、`task_status` 1615→132、`companion_memory` 2656→549、`companion_profile` 1348→582；参数 schema 还在，但操作语义从参数名还原不回来。
- **保留 WORK_RULES 作为最高 recency 护栏**：部分否决——主 Code 的 `default.md` 已覆盖继续完成/尊重取消/处理阻塞，但子任务走独立提示路线没有这份兜底，所以只切主 Code。
- **让飞行记录仪按 USD 兜底币种以对齐侧栏**：否决——FR 的价值在"未采集 ≠ 0"；真正的修法是补价目表，让币种有确定来源。

## 后果

- 固定前缀净减约 1.5k token/轮（工具说明 −1409、describeSkill −75、shell −16、WORK_RULES −76）；tool-trim 退役让被误剪的原生描述恢复完整（Code 侧约 +497），合计净约 −1.1k。
- 工具定义段自首个改动工具起前缀失效一次；WORK_RULES 位于 system 最末，失效边界只到该段。
- `work-rules.md` 锚点与登记表改为 conditional（仅子任务），`prompt-patches.yml` 补复核记录。
- 识别签名：工具描述再次变长，先查是否有人把"何时用/何时不用"的完整示例加回来；新插件若按长度或名称裁剪他人文案，先验证判据是否真能命中目标。
