import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, Show, createMemo, splitProps } from "solid-js"
import { Icon, type IconProps } from "./icon"
import { Spinner } from "../../components/spinner"
import "./button-v2.css"

export interface ButtonV2Props
  extends ComponentProps<typeof Kobalte>, Pick<ComponentProps<"button">, "class" | "classList" | "children"> {
  size?: "small" | "normal" | "large"
  variant?: "primary" | "success" | "warning" | "danger" | "neutral" | "contrast" | "ghost"
  loading?: boolean
  icon?: IconProps["name"]
}

export function ButtonV2(props: ButtonV2Props) {
  const [split, rest] = splitProps(props, ["variant", "size", "icon", "class", "classList", "loading", "disabled"])
  const resolvedIcon = createMemo(() => split.icon)
  return (
    <Kobalte
      {...rest}
      disabled={split.disabled || split.loading}
      aria-busy={split.loading || rest["aria-busy"]}
      data-component="button-v2"
      data-size={split.size || "normal"}
      data-variant={split.variant || "neutral"}
      data-icon={resolvedIcon()}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Show
        when={split.loading}
        fallback={
          <Show when={resolvedIcon()}>
            <Icon name={resolvedIcon()!} size="small" />
          </Show>
        }
      >
        <span aria-hidden="true">
          <Spinner class="size-3" />
        </span>
      </Show>
      {props.children}
    </Kobalte>
  )
}
