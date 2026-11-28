import { createMemo, createSignal, For, Show } from "solid-js"
import { createQuery } from "@tanstack/solid-query"
import type { AssistantMessage, Session } from "@redcode-ai/sdk/v2"
import { getFilename } from "@redcode-ai/core/util/path"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Icon } from "@redcode-ai/ui/icon"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { ImagePreview } from "@redcode-ai/ui/image-preview"
import { dataUrlFromMediaValue } from "@redcode-ai/ui/pierre/media"
import { Spinner } from "@redcode-ai/ui/spinner"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { collectTurnDeliverables } from "./session/turn-deliverables"

type Result = { directory: string; path: string; bytes?: number }

export function HomeRecentImages(props: { sessions: Session[] }) {
  const sync = useServerSync()
  const language = useLanguage()
  const images = createMemo(() => {
    const found = new Map<string, Result>()
    // Only inspect already loaded messages. Opening Home never fans out into transcript requests.
    for (const session of props.sessions.slice(0, 12)) {
      const [store] = sync.child(session.directory, { bootstrap: false })
      const messages = (store.message[session.id] ?? [])
        .slice(-16)
        .filter((m): m is AssistantMessage => m.role === "assistant")
      for (const message of messages.toReversed()) {
        const parts = store.part[message.id] ?? []
        const outputs = collectTurnDeliverables({
          userMessageID: message.parentID,
          directory: session.directory,
          messages: [message],
          parts: () => parts,
        })
        for (const output of outputs.toReversed()) {
          if (output.kind !== "image" || !/\.(png|jpe?g|webp|gif|avif)$/i.test(output.path)) continue
          const part = parts.find((part) => part.id === output.partID)
          const bytes =
            part?.type === "tool" && part.state.status === "completed" ? part.state.metadata.bytes : undefined
          const key = JSON.stringify([session.directory, output.path])
          if (found.has(key)) continue
          found.set(key, {
            directory: session.directory,
            path: output.path,
            bytes: typeof bytes === "number" ? bytes : undefined,
          })
          if (found.size === 3) return [...found.values()]
        }
      }
    }
    return [...found.values()]
  })
  return (
    <Show when={images().length}>
      <section class="home-recent-images" aria-label={language.t("home.recentImages")}>
        <h3>{language.t("home.recentImages")}</h3>
        <div class="home-image-grid">
          <For each={images()}>{(result) => <ImageTile result={result} />}</For>
        </div>
      </section>
    </Show>
  )
}

function ImageTile(props: { result: Result }) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [requested, setRequested] = createSignal(false)
  const auto = () => (props.result.bytes ?? Infinity) <= 768 * 1024
  const label = () => getFilename(props.result.path)
  const preview = createQuery(() => ({
    queryKey: ["home", "image", sdk.url, props.result.directory, props.result.path],
    enabled: auto() || requested(),
    staleTime: 60_000,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await sdk.client.file.read(
        { directory: props.result.directory, path: props.result.path },
        { signal },
      )
      return dataUrlFromMediaValue(result.data, "image") ?? null
    },
  }))
  const open = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    const button = event.currentTarget
    setRequested(true)
    dialog.show(
      () => (
        <Show
          when={preview.data}
          fallback={
            <Dialog title={label()} size="normal">
              <div class="px-4 py-3" role="status">
                <Show when={preview.isFetching} fallback={language.t("common.requestFailed")}>
                  {language.t("common.loading")}
                </Show>
              </div>
            </Dialog>
          }
        >
          {(url) => <ImagePreview src={url()} alt={label()} />}
        </Show>
      ),
      () => button.focus(),
    )
  }
  return (
    <button type="button" class="home-image-tile" title={props.result.path} onClick={open}>
      <span class="home-image-frame" aria-hidden="true">
        <Show when={preview.data} fallback={preview.isFetching ? <Spinner /> : <Icon name="open-file" />}>
          {(url) => <img src={url()} alt="" loading="lazy" decoding="async" />}
        </Show>
      </span>
      <span class="home-image-title">{label()}</span>
    </button>
  )
}
