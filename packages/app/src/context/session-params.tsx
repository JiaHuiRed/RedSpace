import { useParams } from "@solidjs/router"
import { createContext, type ParentProps, useContext } from "solid-js"

type SessionParams = { readonly dir?: string; readonly id?: string }
const WorkspaceSessionParams = createContext<SessionParams>()

// A Code home draft has a real workspace, but no session ID or directory segment in its URL.
export function WorkspaceSessionScope(props: ParentProps<{ directorySlug: string }>) {
  return (
    <WorkspaceSessionParams.Provider
      value={{
        get dir() {
          return props.directorySlug
        },
      }}
    >
      {props.children}
    </WorkspaceSessionParams.Provider>
  )
}

export function useWorkspaceSessionParams() {
  return useContext(WorkspaceSessionParams)
}

export function useSessionParams() {
  return useWorkspaceSessionParams() ?? useParams()
}
