import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { ProviderQuota, UserMessage } from "@redcode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

const id = "internal:sidebar-quota"

// 261128 Red 当前会话实际使用的套餐置顶。优先 local.model.current()——prompt 在切会话时
// 用它同步最后一条用户消息的模型，之后用户换模型（还没发送）也会立刻反映在侧栏；拿不到真实
// 选择（模型列表尚未就绪）时退回最后一条用户消息 / session.model 的实际模型。
// 只匹配 provider——额度快照的 accountID 在 TUI 侧没有“当前账户”来源，同 provider 多账号时
// 不下钻猜具体账号。
type QuotaOrder = { rows: ReadonlyArray<ProviderQuota>; providerID?: string; single: boolean }

function sessionProvider(api: TuiPluginApi, sessionID: string): string | undefined {
  const lastUser = api.state.session
    .messages(sessionID)
    .findLast((message): message is UserMessage => message.role === "user" && !!message.model?.providerID)
  return lastUser?.model.providerID ?? api.state.session.get(sessionID)?.model?.providerID
}

function orderQuota(quotas: ReadonlyArray<ProviderQuota>, providerID: string | undefined): QuotaOrder {
  if (!providerID) return { rows: quotas, single: false }
  const current = quotas.filter((quota) => quota.providerID === providerID)
  if (current.length === 0) return { rows: quotas, single: false }
  return {
    // 稳定排序：同一 provider 的多份快照和其余套餐都保持原相对顺序。
    rows: [...current, ...quotas.filter((quota) => quota.providerID !== providerID)],
    providerID,
    single: current.length === 1,
  }
}

// 260919 Red 额度面板：GET /provider/quota + provider.quota.updated 全局事件。
// 服务端同时捕获 GPT 响应头并查询 GLM Coding Plan 监控接口；这里每分钟触发一次刷新。
export function QuotaView(props: { api: TuiPluginApi; session_id: string }) {
  const local = useLocal()
  const theme = () => props.api.theme.current
  // 260929 Red 第三个账单面板（Step Plan）进来后，三套餐齐显会挤爆侧栏；对齐 MCP 的折叠模式，
  // 多于一个套餐才出箭头，单套餐保持原样不折。
  const [open, setOpen] = createSignal(true)
  const list = createMemo(() => props.api.state.provider_quota())
  const view = createMemo(() =>
    orderQuota(list(), local.model.current()?.providerID ?? sessionProvider(props.api, props.session_id)),
  )
  const providerName = (providerID: string) =>
    props.api.state.provider.find((provider) => provider.id === providerID)?.name ?? providerID

  onMount(() => {
    const timer = setInterval(() => {
      // 监控接口失败不应打断侧栏，旧快照仍由全局事件保留。
      void props.api.client.provider.quota({ directory: props.api.state.path.directory }).catch(() => {})
    }, 60_000)
    onCleanup(() => clearInterval(timer))
  })

  const color = (pct: number) => {
    if (pct >= 90) return theme().error
    if (pct >= 70) return theme().warning
    return theme().info
  }

  // 260902 cc 拆成 filled / rest 两段，跟 context.tsx 的 bar() 一个形状——原来整条（含已用
  // 部分）都上 textMuted，等于画了条没颜色的灰带，3% 的时候完全看不出这是个进度条。
  // 宽度仍是 10 不复用 context 的 24：这一行还要放 label / 百分比 / 窗口长度 / 重置时刻，
  // 侧栏只有 ~38 列，24 会把后面的字全挤掉。
  const bar = (pct: number, width = 10) => {
    const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
    return { filled: "█".repeat(filled), rest: "░".repeat(Math.max(0, width - filled)) }
  }

  // 侧栏只有 ~38 列，36 字符的账号 ID 一定换行；而套餐名没写 flexShrink 时会被 flex 压缩，
  // 实测 "plus" 被压成 "plu"（末字被账号 ID 顶掉）。取 UUID 第一段足够区分账号。
  const shortAccount = (id: string) => id.split("-")[0] || id

  // 时长：>1440 显示 d，>60 显示 h，否则 m
  const duration = (minutes: number) => {
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
    return `${minutes}m`
  }

  // 260903 Red 长窗口补日期，避免 7d 的重置时间看起来像“每天同一时刻”
  const reset = (resetAt: number, includeDate: boolean) => {
    if (!resetAt) return ""
    const date = new Date(resetAt * 1000)
    const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    if (!includeDate) return time
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`
  }

  // 260831 Red hey-api 把数字字段生成成 number | 字符串三元组，统一归一化为 number
  const WindowRow = (props: {
    label: string
    window: { usedPercent?: number | string; windowMinutes?: number | string; resetAt?: number | string }
    showDuration?: boolean
    monthly?: boolean
  }) => {
    const pct = () => Number(props.window.usedPercent ?? 0)
    const minutes = () => Number(props.window.windowMinutes ?? 0)
    const at = () => Number(props.window.resetAt ?? 0)
    return (
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={theme().textMuted}>
          {props.label}
        </text>
        <text flexShrink={0} fg={color(pct())}>
          {pct()}%
        </text>
        <text flexShrink={0}>
          <span style={{ fg: color(pct()) }}>{bar(pct()).filled}</span>
          <span style={{ fg: theme().textMuted }}>{bar(pct()).rest}</span>
        </text>
        <Show when={props.showDuration !== false && minutes() > 0}>
          <text fg={theme().textMuted}>{duration(minutes())}</text>
        </Show>
        <Show when={at() > 0}>
          <text fg={theme().textMuted}>→ {reset(at(), props.monthly || minutes() >= 1440)}</text>
        </Show>
      </box>
    )
  }

  return (
    <Show when={list().length > 0}>
      {/* 260615 Red section with border title */}
      <box
        border={["top"]}
        borderColor={theme().borderSubtle ?? theme().textMuted}
        title=" Quota "
        titleAlignment="left"
        paddingTop={0}
      >
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => list().length > 1 && setOpen((x) => !x)}
        >
          <Show when={list().length > 1}>
            <text fg={theme().textMuted}>{open() ? "▾" : "▸"}</text>
          </Show>
        </box>
        <Show when={list().length <= 1 || open()}>
          <Show when={view().single ? undefined : view().providerID}>
            {(providerID) => <text fg={theme().textMuted}>当前供应商 · {providerName(providerID())}</text>}
          </Show>
          <For each={view().rows}>
            {(q) => (
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" justifyContent="space-between" gap={1}>
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} fg={theme().text}>
                      <b>{q.planType}</b>
                    </text>
                    <Show when={view().single && q.providerID === view().providerID}>
                      <text flexShrink={0} fg={theme().success}>
                        当前
                      </text>
                    </Show>
                  </box>
                  <Show when={q.accountID}>
                    {(accountID) => <text fg={theme().textMuted}>{shortAccount(accountID())}</text>}
                  </Show>
                </box>
                <Show when={q.primary}>
                  <WindowRow label="Primary" window={q.primary!} />
                </Show>
                <Show when={q.secondary}>
                  <WindowRow label="Weekly" window={q.secondary!} showDuration={false} />
                </Show>
                <Show when={q.monthly}>
                  <WindowRow label="Monthly" window={q.monthly!} monthly />
                </Show>
                <Show when={q.reserve}>
                  <WindowRow label={q.reserveName ?? "Reserve"} window={q.reserve!} />
                </Show>
                <Show when={!q.primary && !q.secondary && !q.reserve && !q.monthly}>
                  <text fg={theme().textMuted}>—</text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <QuotaView api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
