import { Popover as Kobalte } from "@kobalte/core/popover"
import { Show, createMemo, createSignal, type Component } from "solid-js"
import { Button } from "@redcode-ai/ui/button"
import { Icon } from "@redcode-ai/ui/icon"
import { ProviderIcon } from "@redcode-ai/ui/provider-icon"
import { useModels, type ModelKey } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { ModelEffortPicker } from "./model-effort-picker"

export const ChatComposerTools: Component<{
  disabled?: boolean
  /** 伙伴所在目录，供应商连接状态按它取。 */
  directory: () => string
  catalog: ReturnType<ReturnType<typeof useModels>["catalog"]>
  model: ModelKey | undefined
  variant: string | undefined
  onModelChange: (value: ModelKey | undefined) => void
  onVariantChange: (value: string | undefined) => void
  /** 管理模型 / 连接供应商入口（Chat 首页没有 LocalProvider，走设置弹窗对应页签）。 */
  onManage: () => void
  onConnect: () => void
  class?: string
}> = (props) => {
  const language = useLanguage()
  const models = useModels()
  const providers = useProviders(props.directory)
  const sync = useServerSync()
  // 261121 Red 统一弹层：两个触发钮收紧成一个（推理强度只在弹层里调，哥哥确认重复）。
  const [open, setOpen] = createSignal(false)
  // 261121 Red 打开弹层时兜底拉一次目录级 providers——首页首挂的 bootstrap 若失败或
  // 被队列饿死（哥哥报的「只剩默认模型」），这里就是每次打开都重试的用户侧恢复向量；
  // ensureProviders 内部有缓存守卫，已加载时零开销。
  const openPicker = (next: boolean) => {
    setOpen(next)
    if (next) sync.ensureProviders(props.directory())
  }

  const current = createMemo(() => (props.model ? props.catalog.find(props.model) : undefined))
  return (
    <div class={`flex min-w-0 flex-wrap items-center gap-1 ${props.class ?? ""}`}>
      <Kobalte open={open()} onOpenChange={openPicker} placement="top-start" gutter={8}>
        <Kobalte.Trigger
          as={Button}
          variant="ghost"
          size="small"
          disabled={props.disabled}
          data-action="chat-choose-model"
          class="min-w-0 max-w-[220px] justify-start gap-1.5 text-12-regular text-text-weak"
        >
          <Show when={current()?.provider.id}>
            {(providerID) => <ProviderIcon id={providerID()} class="size-3.5 shrink-0" role="img" aria-hidden />}
          </Show>
          <span class="truncate">{current()?.name ?? language.t("chat.composer.model.auto")}</span>
          <Icon name="chevron-down" size="small" class="shrink-0" />
        </Kobalte.Trigger>
        <Kobalte.Portal>
          <Kobalte.Content
            data-component="chat-model-popover"
            class="flex max-h-[min(32rem,72vh)] w-80 flex-col overflow-visible rounded-xl border border-border-weak-base bg-surface-raised-base p-2 shadow-lg z-50 outline-none"
          >
            <ModelEffortPicker
              open={open}
              providers={providers.connected}
              recentModels={() => models.recent.list().map(models.find)}
              catalog={props.catalog}
              currentModel={() => props.model}
              onModelSelect={(picked) => {
                models.recent.push(picked)
                props.onModelChange(picked)
                setOpen(false)
              }}
              onReset={() => {
                props.onModelChange(undefined)
                setOpen(false)
              }}
              onManage={props.onManage}
              onConnect={props.onConnect}
              effort={{
                steps: Object.keys(current()?.variants ?? {}),
                current: () => props.variant,
                onChange: props.onVariantChange,
                unselectedLabel: language.t("prompt.variant.modelDefault"),
              }}
            />
          </Kobalte.Content>
        </Kobalte.Portal>
      </Kobalte>
      {/* 261121 Red picker v2：高强度 chip 删除（哥哥确认与统一弹层重复）——推理强度只在
          弹层里调，模型触发钮一个入口。 */}
    </div>
  )
}
