import type { ParentProps } from "solid-js"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"
import { TerminalProvider } from "@/context/terminal"

export function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}
