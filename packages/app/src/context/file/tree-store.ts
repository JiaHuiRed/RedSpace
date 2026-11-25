import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@redcode-ai/sdk/v2"

export type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

export type TreeSnapshot = {
  node: Record<string, FileNode>
  dir: Record<string, DirectoryState>
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = new Map<string, Promise<void>>()

  const reset = () => {
    inflight.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const evictDirectories = (dirs: string[]) => {
    if (!dirs.length) return
    const evicted = (key: string) => dirs.some((dir) => key === dir || key.startsWith(dir + "/"))
    for (const key of inflight.keys()) {
      if (evicted(key)) inflight.delete(key)
    }
    setTree(
      produce((draft) => {
        for (const key of Object.keys(draft.dir)) {
          if (evicted(key)) delete draft.dir[key]
        }
        for (const key of Object.keys(draft.node)) {
          if (evicted(key)) delete draft.node[key]
        }
      }),
    )
  }

  const listDir = (input: string, opts?: { force?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending) return pending

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )

    const directory = options.scope()

    const promise: Promise<void> = options
      .list(dir)
      .then((nodes) => {
        if (options.scope() !== directory || inflight.get(dir) !== promise) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)
        const nextDirs = new Set(nodes.filter((node) => node.type === "directory").map((node) => node.path))
        const removedDirs = prevChildren.filter(
          (child) => tree.node[child]?.type === "directory" && !nextDirs.has(child),
        )
        evictDirectories(removedDirs)

        setTree(
          "node",
          produce((draft) => {
            for (const child of prevChildren) {
              if (nextSet.has(child)) continue
              delete draft[child]
            }

            for (const node of nodes) {
              draft[node.path] = node
            }
          }),
        )

        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.children = nextChildren
          }),
        )
      })
      .catch((e) => {
        if (options.scope() !== directory || inflight.get(dir) !== promise) return
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = e.message
          }),
        )
        options.onError(e.message)
      })
      .finally(() => {
        if (inflight.get(dir) === promise) inflight.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  const expandDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  return {
    listDir,
    refreshDir: (input: string, replacedChild?: string) => {
      if (replacedChild) evictDirectories([options.normalizeDir(replacedChild)])
      return listDir(input, { force: true })
    },
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    // 261110 Red 跨工作区现场保留：浅拷贝快照供离开时存档，restore 时 reconcile
    // 接管（之后与快照对象独立演化）
    snapshot: (): TreeSnapshot => ({ node: { ...tree.node }, dir: { ...tree.dir } }),
    restore: (input: TreeSnapshot) => {
      setTree(
        reconcile({
          node: input.node,
          dir: { "": { expanded: true }, ...input.dir },
        }),
      )
    },
    reset,
  }
}
