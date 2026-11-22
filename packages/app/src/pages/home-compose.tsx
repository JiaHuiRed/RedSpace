import { base64Encode } from "@redcode-ai/core/util/encode"
import { useSearchParams } from "@solidjs/router"
import { createEffect, on, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { PromptInput } from "@/components/prompt-input"
import { NewSessionDesignView } from "@/components/session/session-new-design-view"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { SDKProvider } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { WorkspaceSessionScope } from "@/context/session-params"
import { SessionProviders } from "@/context/session-providers"
import { DirectoryDataProvider } from "@/pages/directory-layout"

export default function HomeCompose(props: {
  directory: string
  onProjectChange: (directory: string) => void
  onSubmit: () => void
  focusRequest: number
}) {
  const sync = useServerSync()
  onMount(() => sync.ensureProviders(props.directory))

  return (
    <WorkspaceSessionScope directorySlug={base64Encode(props.directory)}>
      <SDKProvider directory={props.directory}>
        <DirectoryDataProvider directory={props.directory}>
          <SessionProviders>
            <HomeComposer {...props} />
          </SessionProviders>
        </DirectoryDataProvider>
      </SDKProvider>
    </WorkspaceSessionScope>
  )
}

function HomeComposer(props: Parameters<typeof HomeCompose>[0]) {
  const language = useLanguage()
  const prompt = usePrompt()
  const [searchParams, setSearchParams] = useSearchParams<{ soul?: string; prompt?: string }>()
  const [state, setState] = createStore({ worktree: "main", soul: undefined as string | undefined })
  let editor: HTMLDivElement | undefined
  let handledFocus = 0

  const focus = () => {
    if (!editor || props.focusRequest <= handledFocus) return
    handledFocus = props.focusRequest
    editor.focus()
    editor.scrollIntoView({ block: "nearest" })
  }
  createEffect(on(() => props.focusRequest, focus))
  createEffect(() => {
    const text = searchParams.prompt
    if (!text || !prompt.ready()) return
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    setSearchParams({ prompt: undefined }, { replace: true })
  })
  createEffect(
    on(
      () => searchParams.soul,
      (soul) => {
        if (!soul) return
        setState("soul", soul)
        setSearchParams({ soul: undefined }, { replace: true })
      },
    ),
  )

  return (
    <NewSessionDesignView
      embedded
      worktree={state.worktree}
      newSessionSoul={() => state.soul}
      onNewSessionSoulChange={(soul) => setState("soul", soul)}
      onProjectChange={props.onProjectChange}
    >
      <Show
        when={prompt.ready()}
        fallback={<div class="min-h-32 rounded-md bg-background-base/50 px-4 py-3 text-text-weak">{language.t("prompt.loading")}</div>}
      >
        <PromptInput
          variant="new-session"
          ref={(el) => {
            editor = el
            queueMicrotask(focus)
          }}
          newSessionWorktree={state.worktree}
          onNewSessionWorktreeChange={(worktree) => setState("worktree", worktree)}
          onNewSessionWorktreeReset={() => setState("worktree", "main")}
          newSessionSoul={() => state.soul}
          onSubmit={props.onSubmit}
        />
      </Show>
    </NewSessionDesignView>
  )
}
