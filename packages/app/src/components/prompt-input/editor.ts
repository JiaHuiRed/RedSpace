import { createEffect, on } from "solid-js"
import { type ContentPart, isPromptEqual, type Prompt } from "@/context/prompt"
import { promptLength } from "./history"
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
  readonly composing: () => boolean
  readonly renderPart: (part: ContentPart) => HTMLElement | undefined
  readonly onExternalChange: () => void
}

// 261128 Red 架构审计第 2 步：组合输入、光标恢复、草稿与 contenteditable 的同步
// 共用同一个编辑器引用。editorRef 仍由 PromptInput 持有并通过 accessor 传入，
// 这组闭包先收进控制器，后续再把引用所有权一并迁过来。
export function createEditorController(config: EditorControllerConfig) {
  const mirror = { input: false }
  const inset = 56

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
        if (config.composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  return {
    markInput: () => {
      mirror.input = true
    },
    queueScroll,
    getCaretState,
    clearEditor,
    setEditorText,
    focusEditorEnd,
    restoreFocus,
    reconcile,
  }
}
