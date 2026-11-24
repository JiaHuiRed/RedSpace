import { Popover } from "@kobalte/core/popover"
import { useNavigate } from "@solidjs/router"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Show, createEffect, createMemo, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2/client"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { Icon } from "@redcode-ai/ui/icon"
import { DropdownMenu } from "@redcode-ai/ui/dropdown-menu"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Mark } from "@redcode-ai/ui/logo"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServerSync } from "@/context/server-sync"
import { notifyServerError } from "@/utils/notify-error"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { companionSessions, newConversationHref } from "@/utils/product-mode"
import { CompanionDreamDiary } from "./companion-dream-diary"
import { SoulAvatar } from "./soul-avatar"
import "./companion-chat-frame.css"

type HistoryOwner = { id: string; directory: string }

async function historyPage(
  sdk: ReturnType<typeof useGlobalSDK>,
  owner: HistoryOwner,
  archived: boolean,
  cursor: string | undefined,
  signal: AbortSignal,
) {
  const result = await sdk.client.experimental.session.list(
    {
      directory: owner.directory,
      roots: true,
      mode: "chat",
      companionID: owner.id,
      archivedOnly: archived,
      cursor,
      limit: 100,
    },
    { throwOnError: true, signal },
  )
  return {
    sessions: companionSessions(result.data, owner.id, archived),
    next: result.response.headers.get("x-next-cursor") ?? undefined,
  }
}

export function useCompanionHistory(owner: () => HistoryOwner | undefined, archived = false) {
  const sdk = useGlobalSDK()
  return useInfiniteQuery(() => {
    const selected = owner()
    return {
      queryKey: ["companion", sdk.url, selected?.id, "sessions", archived, selected?.directory],
      enabled: !!selected,
      refetchOnMount: true,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: Awaited<ReturnType<typeof historyPage>>) => last.next,
      queryFn: ({ signal, pageParam }) => historyPage(sdk, selected!, archived, pageParam, signal),
    }
  })
}

function RenameConversation(props: { session: Session; save: (title: string) => Promise<boolean> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [form, setForm] = createStore({ title: props.session.title, busy: false })
  let input!: HTMLInputElement
  let mounted = true
  onMount(() => {
    input.focus()
    input.select()
  })
  onCleanup(() => {
    mounted = false
  })
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const title = form.title.trim()
    if (!title || form.busy) return
    setForm("busy", true)
    const saved = await props.save(title)
    if (!mounted) return
    setForm("busy", false)
    if (saved) dialog.close()
  }
  return (
    <Dialog title={language.t("common.rename")}>
      <form class="flex flex-col gap-4 px-4 pb-4" onSubmit={submit}>
        <input
          ref={input}
          aria-label={language.t("common.rename")}
          class="companion-rename-input"
          value={form.title}
          onInput={(event) => setForm("title", event.currentTarget.value)}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={form.busy || !form.title.trim()}>
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function SessionChatFrame(props: { session: Session; children: JSX.Element }) {
  const sdk = useGlobalSDK()
  const profiles = useQuery(() => ({
    queryKey: ["companion", sdk.url, "list"],
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const history = useCompanionHistory(() => {
    const id = props.session.companionID
    return id ? { id, directory: props.session.directory } : undefined
  })
  return (
    <CompanionChatFrame
      profile={profiles.data?.find((p) => p.id === props.session.companionID)}
      session={props.session}
      history={history}
      profiles={profiles.data}
    >
      {props.children}
    </CompanionChatFrame>
  )
}

export function CompanionChatFrame(props: {
  profile?: CompanionInfo
  session?: Session
  history: ReturnType<typeof useCompanionHistory>
  profiles?: CompanionInfo[]
  onChoose?: (id: string) => void
  options?: JSX.Element
  children: JSX.Element
}) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const cache = useQueryClient()
  const sync = useServerSync()
  const [rail, setRail] = persisted(Persist.global("chat.sidebar"), createStore({ collapsed: false }))
  const [ui, setUI] = createStore({
    search: false,
    query: "",
    submitted: "",
    drawer: false,
    menu: false,
    archived: false,
  })
  let searchBox: HTMLInputElement | undefined
  const home = () => newConversationHref("chat", undefined, props.profile?.id ?? props.session?.companionID)
  const owner = () => {
    const id = props.profile?.id ?? props.session?.companionID
    const directory = props.profile?.directory ?? props.session?.directory
    return id && directory ? { id, directory } : undefined
  }
  const archives = useCompanionHistory(() => (ui.archived ? owner() : undefined), true)
  const list = () => (ui.archived ? archives : props.history)
  const listed = createMemo(() => list().data?.pages.flatMap((page) => page.sessions) ?? [])
  const matchesTitle = (session: Session, query: string) =>
    session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const contents = useQuery(() => {
    const selected = owner()
    const q = ui.submitted
    const archived = ui.archived
    return {
      queryKey: ["companion-history-search", sdk.url, selected?.id, selected?.directory, archived, q],
      enabled: !!q && !!selected && !!list().data,
      retry: false,
      queryFn: async ({ signal }) => {
        const matches: Session[] = []
        const scan = async (sessions: Session[]) => {
          for (const session of sessions) {
            signal.throwIfAborted()
            if (matchesTitle(session, q)) {
              matches.push(session)
              continue
            }
            let cursor: string | undefined
            do {
              const response = await sdk.client.session.query(
                { directory: session.directory, sessionID: session.id, q, cursor, limit: "1" },
                { signal, throwOnError: true },
              )
              if (response.data.results.length) {
                matches.push(session)
                break
              }
              cursor = response.data.nextCursor
            } while (cursor)
          }
        }
        const pages = list().data!.pages
        for (const page of pages) await scan(page.sessions)
        let cursor = pages.at(-1)?.next
        while (cursor) {
          const page = await historyPage(sdk, selected!, archived, cursor, signal)
          await scan(page.sessions)
          cursor = page.next
        }
        return matches
      },
    }
  })
  const history = createMemo(() => {
    const matches = listed().filter((s) => matchesTitle(s, ui.query.trim()))
    if (!ui.submitted || !contents.data) return matches
    return Array.from(new Map([...matches, ...contents.data].map((s) => [s.id, s])).values())
  })
  const changeSession = async (
    session: Session,
    patch: { title: string } | { time: { archived: number } } | { unarchive: true },
  ) => {
    try {
      const result = await sdk.client.session.update(
        { directory: session.directory, sessionID: session.id, ...patch },
        { throwOnError: true },
      )
      if ("title" in patch) {
        const [, setStore] = sync.child(session.directory, { bootstrap: false })
        setStore("session", (s) => s.id === session.id, "title", result.data.title)
      }
      if ("time" in patch && props.session?.id === session.id) void navigate(home())
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["companion", sdk.url, session.companionID, "sessions"] }),
        cache.invalidateQueries({ queryKey: ["companion-history-search", sdk.url, session.companionID] }),
      ])
      return true
    } catch (error) {
      notifyServerError(language.t, error)
      return false
    }
  }
  const day = createMemo(
    () => new Intl.DateTimeFormat(language.locale(), { month: "long", day: "numeric", year: "numeric" }),
  )
  const date = (session: Session) => day().format(session.time.updated ?? session.time.created)
  const closeDrawer = () => setUI("drawer", false)
  const search = () => {
    setUI({ search: true, drawer: window.matchMedia("(max-width: 700px)").matches })
    setRail("collapsed", false)
    queueMicrotask(() => searchBox?.focus())
  }
  const keydown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || document.querySelector('[role="dialog"],dialog[open]')) return
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyN") {
      e.preventDefault()
      void navigate(home())
      closeDrawer()
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyK") {
      e.preventDefault()
      e.stopPropagation()
      search()
    } else if (e.key === "Escape" && (ui.drawer || ui.search)) {
      setUI({ drawer: false, search: false, query: "", submitted: "" })
    }
  }
  onMount(() => {
    window.addEventListener("keydown", keydown, true)
    onCleanup(() => window.removeEventListener("keydown", keydown, true))
  })
  createEffect(() => {
    void props.session?.id
    void props.profile?.id
    setUI({ drawer: false, query: "", submitted: "", search: false, menu: false, archived: false })
  })
  const settings = async () => {
    setUI("menu", false)
    const { DialogSettings } = await import("@/components/dialog-settings")
    dialog.show(() => <DialogSettings initialTab="chat" />)
  }
  const toggleRail = () => {
    if (window.matchMedia("(max-width: 700px)").matches) setUI("drawer", !ui.drawer)
    else setRail("collapsed", !rail.collapsed)
  }
  return (
    <div class="companion-frame" classList={{ folded: rail.collapsed, "drawer-open": ui.drawer }}>
      <button
        type="button"
        class="companion-scrim"
        aria-label={language.t("command.sidebar.toggle")}
        onClick={closeDrawer}
      />
      <aside class="companion-rail" aria-label={language.t("chat.recent")}>
        <div class="companion-brand">
          <a href={home()}>
            <Mark aria-hidden="true" />
            RedSpace
          </a>
          <button
            type="button"
            class="chat-icon"
            onClick={toggleRail}
            aria-label={language.t("command.sidebar.toggle")}
          >
            <Icon name="layout-left" />
          </button>
        </div>
        <a class="companion-new" href={home()} onClick={closeDrawer}>
          <Icon name="new-session" />
          {language.t("chat.ui.new")}
          <kbd>Alt N</kbd>
        </a>
        <Show
          when={ui.search}
          fallback={
            <button type="button" class="companion-search" onClick={search}>
              <Icon name="magnifying-glass" />
              {language.t("chat.ui.search")}
            </button>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setUI("submitted", ui.query.trim())
            }}
          >
            <input
              ref={searchBox}
              type="search"
              class="companion-filter"
              aria-label={language.t("chat.ui.search")}
              placeholder={language.t("chat.ui.search")}
              value={ui.query}
              onInput={(e) => setUI({ query: e.currentTarget.value, submitted: "" })}
            />
            <Show when={ui.query.trim()}>
              <button type="submit" class="companion-search-body" disabled={contents.isFetching}>
                {language.t(contents.isFetching ? "session.search.searching" : "chat.ui.searchBody")}
              </button>
            </Show>
          </form>
        </Show>
        <button
          type="button"
          class="companion-search"
          aria-pressed={ui.archived}
          onClick={() => setUI({ archived: !ui.archived, query: "", submitted: "" })}
        >
          <Icon name="archive" />
          {language.t("home.sessions.archived.toggle")}
        </button>
        <nav class="companion-history" aria-label={language.t("chat.recent")}>
          <Show when={ui.submitted && contents.isError}>
            <button type="button" onClick={() => void contents.refetch()}>
              {language.t("common.retry")}
            </button>
          </Show>
          <Show when={list().isError && !list().isFetchNextPageError}>
            <button type="button" onClick={() => void list().refetch()}>
              {language.t("common.retry")}
            </button>
          </Show>
          <For each={history()}>
            {(s, index) => (
              <>
                <Show when={!index() || date(history()[index() - 1]!) !== date(s)}>
                  <p>{date(s)}</p>
                </Show>
                <div class="companion-history-row">
                  <a
                    href={`/${base64Encode(s.directory)}/session/${s.id}`}
                    aria-current={props.session?.id === s.id ? "page" : undefined}
                    onClick={closeDrawer}
                    title={s.title}
                  >
                    {s.title}
                  </a>
                  <DropdownMenu placement="bottom-end">
                    <DropdownMenu.Trigger
                      class="chat-icon"
                      aria-label={language.t("common.moreOptions") + " · " + s.title}
                    >
                      <Icon name="dot-grid" size="small" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          onSelect={() =>
                            dialog.show(() => (
                              <RenameConversation session={s} save={(title) => changeSession(s, { title })} />
                            ))
                          }
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() =>
                            void changeSession(
                              s,
                              ui.archived ? { unarchive: true } : { time: { archived: Date.now() } },
                            )
                          }
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t(ui.archived ? "command.session.unarchive" : "common.archive")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </>
            )}
          </For>
          <Show when={list().hasNextPage && !ui.submitted}>
            <button type="button" disabled={list().isFetchingNextPage} onClick={() => void list().fetchNextPage()}>
              {language.t(list().isFetchNextPageError ? "common.retry" : "common.loadMore")}
            </button>
          </Show>
          <Show
            when={
              !history().length && !list().isLoading && !list().isError && !contents.isFetching && !contents.isError
            }
          >
            <p>
              {language.t(
                ui.query
                  ? "chat.history.noMatches"
                  : ui.archived
                    ? "home.sessions.archived.empty"
                    : "chat.recent.empty",
              )}
            </p>
          </Show>
        </nav>
        <Show when={props.profile}>
          {(profile) => (
            <button
              type="button"
              class="companion-profile"
              onClick={() => {
                closeDrawer()
                setUI("menu", true)
              }}
            >
              <SoulAvatar
                id={profile().soulID}
                soul={{ id: profile().soulID, name: profile().name, displayName: profile().name }}
              />
              <span>{profile().name}</span>
              <Icon name="chevron-grabber-vertical" size="small" />
            </button>
          )}
        </Show>
      </aside>
      <main class="companion-stage">
        <header class="companion-bar">
          <button
            type="button"
            class="chat-icon companion-reopen"
            onClick={toggleRail}
            aria-label={language.t("command.sidebar.toggle")}
          >
            <Icon name="layout-left" />
          </button>
          <a href={home()}>Chat</a>
          <span aria-hidden="true">/</span>
          <span class="companion-page-title">{props.session?.title || language.t("chat.ui.new")}</span>
          <button
            type="button"
            class="chat-icon companion-settings"
            onClick={() => void settings()}
            aria-label={language.t("settings.title")}
          >
            <Icon name="settings-gear" />
          </button>
          <Popover open={ui.menu} onOpenChange={(open) => setUI("menu", open)} placement="bottom-end" gutter={6}>
            <Popover.Trigger class="chat-icon companion-more" aria-label={language.t("chat.ui.options")}>
              <Icon name="dot-grid" />
            </Popover.Trigger>
            <Popover.Content class="companion-options">
              <Show when={props.profiles?.length}>
                <select
                  aria-label={language.t("settings.companion.choose")}
                  value={props.profile?.id ?? props.session?.companionID ?? ""}
                  onChange={(event) => {
                    const id = event.currentTarget.value
                    setUI("menu", false)
                    if (props.onChoose) props.onChoose(id)
                    else void navigate(newConversationHref("chat", undefined, id))
                  }}
                >
                  <Show when={!props.profile && !props.session?.companionID}>
                    <option value="" disabled>
                      {language.t("settings.companion.choose")}
                    </option>
                  </Show>
                  <For each={props.profiles}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                </select>
              </Show>
              {props.options}
              <Show when={props.profile}>
                {(profile) => (
                  <button
                    type="button"
                    onClick={() => {
                      const owner = profile()
                      setUI("menu", false)
                      dialog.show(() => <CompanionDreamDiary profile={owner} />)
                    }}
                  >
                    {language.t("chat.dreams.title")}
                  </button>
                )}
              </Show>
            </Popover.Content>
          </Popover>
        </header>
        {props.children}
      </main>
    </div>
  )
}
