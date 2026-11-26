import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// 261126 Red FR-04 授权作用域索引。全局扫描不能先读全库再过滤：否则 cursor/coverage/
// scanned 会把其他项目或工作区的行数、时间、id 泄露给当前实例。写入时把 session 的
// project/workspace 与 message 的 detached 投影到本表，扫描只读本表并只返回本作用域。
// 触发器与回填在迁移里维护；这张表是飞行记录器查询的唯一窗口来源。
export const FlightScopeTable = sqliteTable(
  "flight_scope",
  {
    /** step = part 里的 step-finish；request = flight_request 行。 */
    kind: text().notNull(),
    id: text().notNull(),
    message_id: text().notNull(),
    session_id: text().notNull(),
    project_id: text().notNull(),
    workspace_id: text(),
    time_created: integer().notNull(),
    /** 0 = 所属 message 已 detached；不可见于记录器。 */
    visible: integer().notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.id] }),
    // 项目级窗口：kind/visible 是等值条件，放在 time 前才能直接吃索引顺序。
    index("flight_scope_project_time_idx").on(
      table.project_id,
      table.kind,
      table.visible,
      table.time_created,
      table.id,
    ),
    // 工作区级窗口。
    index("flight_scope_workspace_time_idx").on(
      table.project_id,
      table.workspace_id,
      table.kind,
      table.visible,
      table.time_created,
      table.id,
    ),
    // session 删除/项目变更时按会话定位；message 可见性变更按 message 定位。
    index("flight_scope_session_idx").on(table.session_id),
    index("flight_scope_message_idx").on(table.message_id),
  ],
)
