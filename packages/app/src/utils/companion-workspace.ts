import type { CompanionInfo } from "@redcode-ai/sdk/v2/client"

export type IntroductionState = "available" | "active" | "paused" | "complete"

export function introductionState(profile: { introduction?: IntroductionState; needsSetup?: boolean }) {
  return profile.introduction ?? (profile.needsSetup === true ? "available" : "complete")
}

/**
 * 261123 Red 显式身份找不到就不回落（由页面提示重新选择）；记忆的身份可能来自旧档案
 * 命名（companion-<hash> → 目录名迁移），失配时回落到列表第一个，否则旧 id 会把整个
 * Chat 页永久卡在「找不到这位伙伴」。
 */
export function selectCompanion<T extends { id: string }>(
  profiles: readonly T[],
  requested: string | undefined,
  remembered: string | undefined,
) {
  if (requested) return profiles.find((profile) => profile.id === requested)
  return (remembered && profiles.find((profile) => profile.id === remembered)) || profiles[0]
}

export function upsertCompanion(current: CompanionInfo[] | undefined, profile: CompanionInfo) {
  const profiles = current ?? []
  const index = profiles.findIndex((item) => item.id === profile.id)
  return index < 0 ? [...profiles, profile] : profiles.map((item, at) => (at === index ? profile : item))
}

/** The former default draft belonged to the first companion; keep both texts if a newer draft exists. */
export function assignUnboundDraft(messages: Record<string, string>, id: string) {
  const draft = messages.default
  if (!draft) return messages
  const existing = messages[id]
  return { ...messages, default: "", [id]: existing ? `${existing}\n\n${draft}` : draft }
}

export function clearAcceptedDraft(messages: Record<string, string>, id: string, submitted: string) {
  return messages[id] === submitted ? { ...messages, [id]: "" } : messages
}

export function hasCompletedCompanionReply(
  messages: readonly {
    info: { role: string; time: { created: number; completed?: number }; error?: unknown }
    parts: readonly { type: string; text?: string }[]
  }[],
) {
  return messages.some(
    (message) =>
      message.info.role === "assistant" &&
      !!message.info.time.completed &&
      !message.info.error &&
      message.parts.some((part) => part.type === "text" && !!part.text?.trim()),
  )
}
