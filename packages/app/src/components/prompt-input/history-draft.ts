import { type SelectedLineRange, selectionFromLines } from "@/context/file"
import type { useComments } from "@/context/comments"
import type { usePrompt } from "@/context/prompt"
import type { Prompt } from "@/context/prompt"
import {
  navigatePromptHistory,
  promptLength,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
} from "./history"
import type { EditorController } from "./editor"

export interface HistoryDraftConfig {
  readonly editor: EditorController
  readonly prompt: ReturnType<typeof usePrompt>
  readonly comments: ReturnType<typeof useComments>
  readonly entries: () => PromptHistoryStoredEntry[]
  readonly setEntries: (entries: PromptHistoryStoredEntry[]) => void
  readonly shellEntries: () => PromptHistoryStoredEntry[]
  readonly setShellEntries: (entries: PromptHistoryStoredEntry[]) => void
  readonly mode: () => "normal" | "shell"
  readonly historyIndex: () => number
  readonly savedPrompt: () => PromptHistoryEntry | null
  readonly applyingHistory: () => boolean
  readonly setNavigation: (index: number, saved: PromptHistoryEntry | null) => void
  readonly setApplyingHistory: (value: boolean) => void
}

// 261128 Red 架构审计第 2 步：历史导航与草稿恢复自成一块，避免 PromptInput
// 同时持有评论、历史 store 与编辑器的三重状态。
export function createHistoryDraft(config: HistoryDraftConfig) {
  const historyComments = () => {
    const byID = new Map(config.comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return config.prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    config.comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    config.prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    config.setApplyingHistory(true)
    applyHistoryComments(entry.comments)
    config.prompt.set(p, length)
    config.editor.focusAt(length, () => config.setApplyingHistory(false))
  }

  const resetNavigation = (force = false) => {
    if (!force && (config.historyIndex() < 0 || config.applyingHistory())) return
    config.setNavigation(-1, null)
  }

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: config.mode() === "shell" ? config.shellEntries() : config.entries(),
      historyIndex: config.historyIndex(),
      currentPrompt: config.prompt.current(),
      currentComments: historyComments(),
      savedPrompt: config.savedPrompt(),
    })
    if (!result.handled) return false
    config.setNavigation(result.historyIndex, result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const entries = mode === "shell" ? config.shellEntries : config.entries
    const setEntries = mode === "shell" ? config.setShellEntries : config.setEntries
    const next = prependHistoryEntry(entries(), prompt, mode === "shell" ? [] : historyComments())
    if (next === entries()) return
    setEntries(next)
  }

  return { historyComments, applyHistoryPrompt, resetNavigation, navigateHistory, addToHistory }
}
