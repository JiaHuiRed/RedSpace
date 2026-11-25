import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileNode } from "@redcode-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"
import { invalidateFromWatcher } from "./watcher"

test("reopening a same-name replacement lists fresh files even when the parent never sees the deletion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "redspace-file-tree-"))
  try {
    const tree = createFileTreeStore({
      scope: () => root,
      normalizeDir: (name) => name,
      list: async (dir) =>
        (await readdir(path.join(root, dir), { withFileTypes: true })).map((entry): FileNode => ({
          name: entry.name,
          path: path.posix.join(dir, entry.name),
          absolute: path.join(root, dir, entry.name),
          type: entry.isDirectory() ? "directory" : "file",
          ignored: false,
        })),
      onError: (message) => {
        throw new Error(message)
      },
    })
    const nested = path.join(root, "src", "nested")
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(nested, "before.ts"), "")
    await tree.listDir("")
    await tree.listDir("src")
    await tree.listDir("src/nested")

    await rm(path.join(root, "src"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(nested, "after.ts"), "")

    const refreshes: Promise<void>[] = []
    for (const event of ["unlink", "add"]) {
      invalidateFromWatcher(
        { type: "file.watcher.updated", properties: { file: "src", event } },
        {
          normalize: (input) => input,
          windows: false,
          hasFile: () => false,
          loadFile: () => {},
          node: tree.node,
          isDirLoaded: tree.isLoaded,
          refreshDir: (dir, replacedChild) => refreshes.push(tree.refreshDir(dir, replacedChild)),
        },
      )
    }
    await Promise.all(refreshes)
    await tree.listDir("src")
    await tree.listDir("src/nested")
    expect(tree.children("src/nested").map((file) => file.name)).toEqual(["after.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a late listing of a replaced directory cannot overwrite the new listing", async () => {
  const node = (name: string, type: FileNode["type"]): FileNode => ({
    path: name,
    name: path.posix.basename(name),
    absolute: "/" + name,
    type,
    ignored: false,
  })
  let root = [node("src", "directory")]
  const first = Promise.withResolvers<FileNode[]>()
  const second = Promise.withResolvers<FileNode[]>()
  const listings = [first.promise, second.promise]
  const errors: string[] = []
  const tree = createFileTreeStore({
    scope: () => "/project",
    normalizeDir: (dir) => dir,
    list: (dir) => (dir ? listings.shift()! : Promise.resolve(root)),
    onError: (message) => errors.push(message),
  })
  await tree.listDir("")
  const oldRequest = tree.listDir("src")
  root = [node("src", "file")]
  await tree.listDir("", { force: true })
  root = [node("src", "directory")]
  await tree.listDir("", { force: true })
  const freshRequest = tree.listDir("src")
  second.resolve([node("src/fresh.ts", "file")])
  first.resolve([node("src/stale.ts", "file")])
  await Promise.all([oldRequest, freshRequest])
  expect(tree.children("src").map((entry) => entry.path)).toEqual(["src/fresh.ts"])
  expect(errors).toEqual([])
})
