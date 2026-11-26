import { Show } from "solid-js"
import { Icon } from "@redcode-ai/ui/icon"

// 与 home.tsx 的 HOME_PROJECT_NAV_ROW 同一视觉规格；入口单独成文件是为了能在页面
// 依赖（路由/数据上下文）之外直接做 DOM 测试。
const ENTRY_ROW =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] border-0 bg-transparent text-left [font-weight:530] text-v2-text-text-muted transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none h-8 gap-1.5 px-2 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted disabled:opacity-50"

// 261126 Red 没有可用的选中项目时入口必须禁用并写明原因，不能留一个点了没反应的按钮。
export function HomeFlightRecorderEntry(props: {
  label: string
  disabledReason: string
  disabled: boolean
  onOpen: () => void
}) {
  return (
    <>
      <button
        type="button"
        data-testid="home-flight-recorder-open"
        class={ENTRY_ROW}
        disabled={props.disabled}
        title={props.disabled ? props.disabledReason : undefined}
        onClick={props.onOpen}
      >
        <Icon name="terminal" size="small" />
        <span>{props.label}</span>
      </button>
      <Show when={props.disabled}>
        <div data-testid="home-flight-recorder-disabled" class="px-2 text-11-regular text-v2-text-text-faint">
          {props.disabledReason}
        </div>
      </Show>
    </>
  )
}
