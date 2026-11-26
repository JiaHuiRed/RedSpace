import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { MessageTable, SessionTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"
import type { RequestData } from "./flight-recording"

// 261126 Red 本地 Flight Recorder：每次真实模型请求/尝试一行，只存有界指纹分类与白名单数值。
// id 是 RequestEvidence 已分配的单次请求关联号；随消息/会话级联删除；每会话保留最近 128 行
// 由 flight-recording.ts 在写入事务里裁剪。正文、header、账号与错误文本都不进表。
export const FlightRequestTable = sqliteTable(
  "flight_request",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    time_created: integer().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    data: text({ mode: "json" }).notNull().$type<RequestData>(),
  },
  (table) => [
    index("flight_request_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    // 261126 Red 删除单条消息时 SQLite 靠外键级联反查子行：没有这个索引会 SCAN 整张
    // flight_request；message_id 索引把 EXPLAIN 变成 COVERING INDEX。
    index("flight_request_message_id_idx").on(table.message_id),
  ],
)
