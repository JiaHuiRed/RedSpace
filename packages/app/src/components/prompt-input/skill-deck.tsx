import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@redcode-ai/ui/v2/components/button-v2.jsx"
import { Popover } from "@redcode-ai/ui/popover"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import type { SlashCommand } from "./slash-popover"
import "./skill-deck.css"

const filters = ["all", "recent", "favorites"] as const
const LIMIT = 32

// Discovery deliberately uses the same command catalog and selection callback as slash completion.
export function SkillDeck(props: {
  commands: readonly SlashCommand[]
  loaded: readonly string[]
  canSelect: boolean
  onSelect: (command: SlashCommand) => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: false, query: "", filter: "all" as (typeof filters)[number] })
  const [saved, setSaved] = persisted(
    Persist.global("skill-deck"),
    createStore<{ recent: string[]; favorites: string[] }>({ recent: [], favorites: [] }),
  )
  const skills = createMemo(() => props.commands.filter((cmd) => cmd.source === "skill"))
  const visible = createMemo(() => {
    const query = state.query.trim().toLocaleLowerCase()
    const list =
      state.filter === "all"
        ? skills()
        : saved[state.filter].flatMap((id) => skills().find((skill) => skill.id === id) ?? [])
    return list.filter((cmd) => `${cmd.title} ${cmd.description ?? ""}`.toLocaleLowerCase().includes(query))
  })
  function select(cmd: SlashCommand) {
    setSaved("recent", (list) => [cmd.id, ...list.filter((id) => id !== cmd.id)].slice(0, LIMIT))
    setState("open", false)
    queueMicrotask(() => props.onSelect(cmd))
  }
  return (
    <Popover
      open={state.open}
      onOpenChange={(open) => {
        setState("open", open)
        if (open) setState({ query: "", filter: "all" })
      }}
      placement="top-start"
      triggerAs={ButtonV2}
      triggerProps={{ "data-action": "prompt-skills", size: "small", icon: "plus", type: "button" }}
      trigger={language.t("prompt.skills.title")}
      title={language.t("prompt.skills.title")}
      class="prompt-skill-deck"
    >
      <div class="prompt-skill-body">
        <input
          type="search"
          autofocus
          data-action="prompt-skills-search"
          value={state.query}
          aria-label={language.t("prompt.skills.search")}
          placeholder={language.t("prompt.skills.search")}
          onInput={(event) => setState("query", event.currentTarget.value)}
        />
        <div class="flex flex-wrap gap-1">
          <For each={filters}>
            {(filter) => (
              <ButtonV2 size="small" aria-pressed={state.filter === filter} onClick={() => setState("filter", filter)}>
                {language.t(`prompt.skills.${filter}`)}
              </ButtonV2>
            )}
          </For>
        </div>
        <Show when={props.loaded.length}>
          <p class="prompt-skill-loaded">
            {language.t("prompt.skills.loaded")}: {props.loaded.join(" · ")}
          </p>
        </Show>
        <div class="prompt-skill-list">
          <For each={visible()} fallback={<p>{language.t("prompt.skills.empty")}</p>}>
            {(cmd) => (
              <div class="prompt-skill-item">
                <div class="min-w-0">
                  <strong>{cmd.title}</strong>
                  <Show when={cmd.description}>
                    <p title={cmd.description}>{cmd.description}</p>
                  </Show>
                </div>
                <div class="flex shrink-0 gap-1">
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    aria-pressed={saved.favorites.includes(cmd.id)}
                    aria-label={`${language.t("prompt.skills.favorites")}: ${cmd.title}`}
                    onClick={() =>
                      setSaved("favorites", (list) =>
                        list.includes(cmd.id) ? list.filter((id) => id !== cmd.id) : [cmd.id, ...list].slice(0, LIMIT),
                      )
                    }
                  >
                    {saved.favorites.includes(cmd.id) ? "★" : "☆"}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="primary" disabled={!props.canSelect} onClick={() => select(cmd)}>
                    {language.t("prompt.skills.insert")}
                  </ButtonV2>
                </div>
              </div>
            )}
          </For>
        </div>
        <p>{language.t(props.canSelect ? "prompt.skills.hint" : "prompt.skills.draft")}</p>
      </div>
    </Popover>
  )
}
