import type { OpencodeClient } from "@redcode-ai/sdk/v2/client"
import type {
  FlightRecorderGlobalFilters,
  FlightRecorderGlobalPage,
  FlightRecorderGlobalRowsInput,
  FlightRecorderGlobalSummary,
  FlightRecorderGlobalWorkspace,
} from "./flight-recorder-global"

// 261126 Red FR-04：全局执行历史的查询走生成 SDK 的 typed 方法；client 的认证、directory
// 重写与超时由既有 interceptors 统一处理。
const queryOf = (filters: FlightRecorderGlobalFilters) => ({
  ...(filters.from === undefined ? {} : { from: filters.from }),
  ...(filters.to === undefined ? {} : { to: filters.to }),
  ...(filters.providerID === undefined ? {} : { providerID: filters.providerID }),
  ...(filters.modelID === undefined ? {} : { modelID: filters.modelID }),
  ...(filters.sessionID === undefined ? {} : { sessionID: filters.sessionID }),
  ...(filters.workspaceID === undefined ? {} : { workspaceID: filters.workspaceID }),
})

export async function loadFlightRecorderGlobalSummary(
  client: OpencodeClient,
  filters: FlightRecorderGlobalFilters,
): Promise<FlightRecorderGlobalSummary> {
  const response = await client.session.flightRecorderSummary(queryOf(filters), { throwOnError: true })
  return response.data
}

export async function loadFlightRecorderGlobalRows(
  client: OpencodeClient,
  input: FlightRecorderGlobalRowsInput,
): Promise<FlightRecorderGlobalPage> {
  const response = await client.session.flightRecorderRows(
    {
      ...queryOf(input),
      source: input.source,
      limit: input.limit,
      ...(input.before === undefined ? {} : { before: input.before }),
    },
    { throwOnError: true },
  )
  return response.data
}

export async function loadFlightRecorderGlobalWorkspaces(client: OpencodeClient): Promise<FlightRecorderGlobalWorkspace[]> {
  const response = await client.experimental.workspace.list(undefined, { throwOnError: true })
  const list = response.data
  // 形状不符是契约失败，不是“没有工作区”；抛给面板显示错误并提供手输/重试。
  if (!Array.isArray(list)) throw new Error("workspace list response is not an array")
  return list.flatMap((workspace) =>
    typeof workspace.id === "string" && typeof workspace.name === "string"
      ? [{ id: workspace.id, name: workspace.name }]
      : [],
  )
}
