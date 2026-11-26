import type { SnapshotFileDiff, VcsFileDiff } from "@redcode-ai/sdk/v2"
import type { Message } from "@redcode-ai/sdk/v2/client"

type Diff = SnapshotFileDiff | VcsFileDiff

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function fileChange(value: unknown): value is Omit<VcsFileDiff, "patch"> {
  if (!object(value)) return false
  if (typeof value.file !== "string") return false
  if (typeof value.additions !== "number") return false
  if (typeof value.deletions !== "number") return false
  if (value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function withPatch(value: unknown): value is Diff {
  return fileChange(value) && "patch" in value && typeof value.patch === "string"
}

function collect<T>(value: unknown, valid: (item: unknown) => item is T): T[] {
  if (Array.isArray(value)) return value.every(valid) ? value : value.filter(valid)
  if (valid(value)) return [value]
  return object(value) ? Object.values(value).filter(valid) : []
}

export function diffs(value: unknown): Diff[] {
  return collect(value, withPatch)
}

// 261126 Red HTTP patch:false 省略正文，实时事件带正文；会话文件列表只保留元数据。
export function sessionDiffs(value: unknown): SnapshotFileDiff[] {
  return collect(value, fileChange).map(({ file, additions, deletions, status }) => ({
    file,
    additions,
    deletions,
    status,
    patch: "",
  }))
}

export function message(value: Message): Message {
  if (value.role !== "user") return value

  const raw = value.summary as unknown
  if (raw === undefined) return value
  if (!object(raw)) return { ...value, summary: undefined }

  const title = typeof raw.title === "string" ? raw.title : undefined
  const body = typeof raw.body === "string" ? raw.body : undefined
  const next = diffs(raw.diffs)

  if (title === raw.title && body === raw.body && next === raw.diffs) return value

  return {
    ...value,
    summary: {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      diffs: next,
    },
  }
}
