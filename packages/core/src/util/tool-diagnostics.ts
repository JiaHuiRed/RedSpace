export function visibleFileErrors<T>(diagnostics: Record<string, T[]> | undefined, filePath: string | undefined): T[]
export function visibleFileErrors(diagnostics: unknown, filePath: unknown): unknown[]
export function visibleFileErrors(diagnostics: unknown, filePath: unknown): unknown[] {
  if (!diagnostics || typeof diagnostics !== "object" || typeof filePath !== "string" || !filePath) return []
  if (!Object.hasOwn(diagnostics, filePath)) return []
  const items: unknown = Reflect.get(diagnostics, filePath)
  if (!Array.isArray(items)) return []
  const errors = []
  for (const item of items) {
    if (item?.severity !== 1) continue
    errors.push(item)
    if (errors.length === 3) break
  }
  return errors
}

type PartShape = {
  type: string
  tool?: string
  state?: { input: Record<string, unknown>; metadata?: Record<string, unknown> }
}

export function partForDisplay<T extends PartShape>(part: T): T {
  if (part.type !== "tool" || (part.tool !== "edit" && part.tool !== "write")) return part
  const state = part.state
  const metadata = state?.metadata
  if (!state || !metadata?.diagnostics) return part
  const path = state.input.filePath
  const errors = visibleFileErrors(metadata.diagnostics, path)
  const diagnostics = typeof path === "string" && errors.length ? { [path]: errors } : {}
  return { ...part, state: { ...state, metadata: { ...metadata, diagnostics } } }
}
