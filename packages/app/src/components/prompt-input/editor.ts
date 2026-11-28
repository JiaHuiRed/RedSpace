import { createEffect, createSignal, on } from "solid-js"
import { type ContentPart, isPromptEqual, type Prompt } from "@/context/prompt"
import { promptLength, type PromptHistoryStoredEntry } from "./history"
import { findHistorySuggestion } from "./suggestion"
import {
  createTextFragment,
  getCaretState as readCaretState,
  getCursorPosition,
  parseFromDOM,
  setCursorPosition,
} from "./editor-dom"

export interface EditorControllerConfig {
  readonly editor: () => HTMLDivElement
  readonly scroll: () => HTMLDivElement | undefined
  readonly current: () => Prompt
  readonly cursor: () => number | undefined
  readonly mode: () => "normal" | "shell"
  readonly popover: () => "at" | "slash" | null
  readonly historyIndex: () => number
  readonly suggestions: () => PromptHistoryStoredEntry[]
  readonly setPrompt: (parts: Prompt, cursor: number) => void
  readonly resetHistoryNavigation: () => void
  readonly renderPart: (part: ContentPart) => HTMLElement | undefined
  readonly onExternalChange: () => void
}

// 261128 Red 架构审计第 2 步：组合输入、光标恢复、草稿与 contenteditable 的同步
// 共用同一个编辑器引用。editorRef 仍由 PromptInput 持有并通过 accessor 传入，
// 这组闭包先收进控制器，后续再把引用所有权一并迁过来。
export function createEditorController(config: EditorControllerConfig) {
  const mirror = { input: false }
  const inset = 56
  const [composing, setComposing] = createSignal(false)
  const markInput = () => {
    mirror.input = true
  }

  const scrollCursorIntoView = () => {
    const container = config.scroll()
    const editor = config.editor()
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return

    const cursor = getCursorPosition(editor)
    const length = promptLength(config.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const getCaretState = () => readCaretState(config.editor(), config.current)

  const clearEditor = () => {
    config.editor().innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    config.editor().textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      const editor = config.editor()
      editor.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const editor = config.editor()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null
    return getCursorPosition(editor)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const editor = config.editor()
      const cursor = config.cursor() ?? promptLength(config.current())
      editor.focus()
      setCursorPosition(editor, cursor)
      queueScroll()
    })
  }

  const isNormalizedEditor = () =>
    Array.from(config.editor().childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.ghost === "true") return true
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      if (el.dataset.type === "quote") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    const editor = config.editor()
    for (const part of parts) {
      if (part.type === "text") {
        editor.appendChild(createTextFragment(part.content))
        continue
      }
      const rendered = config.renderPart(part)
      if (rendered) editor.appendChild(rendered)
    }

    const last = editor.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editor.appendChild(document.createTextNode("\u200B"))
    }
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(config.editor(), cursor)
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM(config.editor())
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    config.onExternalChange()
    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      config.current,
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  // 260707 Red ghost 补全（历史前缀 inline 建议）：文末光标之后的不可编辑灰字节点，
  // →/End/Tab 接受，任意输入清除。不计入文本长度与光标偏移。
  const clearGhost = () => {
    config.editor()?.querySelectorAll("[data-ghost]").forEach((el) => el.remove())
  }

  const ghostSuffix = () => config.editor()?.querySelector("[data-ghost]")?.textContent ?? ""

  const applyGhost = (suffix: string) => {
    clearGhost()
    if (!suffix) return
    const span = document.createElement("span")
    span.dataset.ghost = "true"
    span.setAttribute("contenteditable", "false")
    span.className = "opacity-40 pointer-events-none select-none"
    span.textContent = suffix
    config.editor().appendChild(span)
  }

  const updateGhost = () => {
    clearGhost()
    if (config.mode() !== "normal" || config.popover() || config.historyIndex() >= 0 || composing()) return
    const parts = config.current().filter((part) => part.type !== "image")
    if (parts.some((part) => part.type !== "text")) return
    const text = parts.map((part) => ("content" in part ? part.content : "")).join("")
    if (!text || text.includes("\n")) return
    const { collapsed, cursorPosition } = getCaretState()
    if (!collapsed || cursorPosition !== text.length) return
    const suffix = findHistorySuggestion(config.suggestions(), text)
    if (suffix) applyGhost(suffix)
  }

  const acceptGhost = () => {
    const suffix = ghostSuffix()
    if (!suffix) return false
    clearGhost()
    const text = config
      .current()
      .filter((part) => part.type !== "image")
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    const full = text + suffix
    markInput()
    config.setPrompt([{ type: "text", content: full, start: 0, end: full.length }], full.length)
    setEditorText(full)
    setCursorPosition(config.editor(), full.length)
    config.resetHistoryNavigation()
    return true
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(config.current().filter((part) => part.type !== "image"))
    })
  }

  const endComposition = () => {
    setComposing(false)
    clearGhost()
  }

  return {
    markInput,
    queueScroll,
    getCaretState,
    clearEditor,
    setEditorText,
    focusEditorEnd,
    restoreFocus,
    reconcile,
    isImeComposing,
    handleCompositionStart,
    handleCompositionEnd,
    endComposition,
    clearGhost,
    ghostSuffix,
    updateGhost,
    acceptGhost,
  }
}
