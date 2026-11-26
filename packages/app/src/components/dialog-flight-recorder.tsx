import { createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { getFilename } from "@redcode-ai/core/util/path"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { Dialog } from "@redcode-ai/ui/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { displayName } from "@/utils/session-helpers"
import { pathKey } from "@/utils/path-key"
import {
  FlightRecorderGlobalPanel,
  type FlightRecorderGlobalFilters,
  type FlightRecorderGlobalRowsInput,
} from "./flight-recorder/flight-recorder-global"
import {
  loadFlightRecorderGlobalRows,
  loadFlightRecorderGlobalSummary,
  loadFlightRecorderGlobalWorkspaces,
} from "./flight-recorder/flight-recorder-global-api"

// 261126 Red FR-04：独立于当前会话的飞行记录仪入口。作用域固定为「当前服务器 + 当前项目」：
// directory 由入口算出项目根，服务端再从 InstanceState 取项目；这里不传 project/remote 参数，
// 也不会遍历其他服务器或项目。面板只在对话框创建后挂载，关闭即卸载，全程不轮询。
export function DialogFlightRecorder(props: { directory: string }) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const layout = useLayout()
  const server = useServer()
  const dialog = useDialog()
  const navigate = useNavigate()

  const project = createMemo(() =>
    layout.projects
      .list()
      .find(
        (item) =>
          pathKey(item.worktree) === pathKey(props.directory) ||
          item.sandboxes?.some((sandbox) => pathKey(sandbox) === pathKey(props.directory)),
      ),
  )
  const projectName = createMemo(() => (project() ? displayName(project()!) : getFilename(props.directory)))
  const client = globalSDK.createClient({ directory: props.directory, throwOnError: true })

  // 跳转前先用 session.get 解析会话真实目录：全局行只带 sessionID/workspaceID，没有目录；
  // 直接按当前项目根跳转会把子工作区里的会话送错实例。session.get 本身按 ID 查库，同一个
  // 认证 client，不遍历会话列表。
  const openSession = async (sessionID: string) => {
    const response = await globalSDK.client.session.get({ sessionID }, { throwOnError: true })
    const directory = response.data?.directory
    if (!directory) throw new Error(language.t("flightRecorder.global.detail.jumpMissing"))
    dialog.close()
    navigate(`/${base64Encode(directory)}/session/${sessionID}`)
  }

  return (
    <Dialog
      size="x-large"
      resizable
      transition
      title={language.t("flightRecorder.global.title")}
      description={
        <span class="text-11-regular text-text-weak">
          {language.t("flightRecorder.global.description", {
            server: server.name || server.key,
            project: projectName(),
          })}
        </span>
      }
    >
      <div class="flex h-full min-h-0 w-full flex-col">
        <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-testid="flight-recorder-global-scroller">
          <FlightRecorderGlobalPanel
            serverName={server.name || server.key}
            projectName={projectName()}
            locale={() => language.intl()}
            t={(key, values) => language.t(key as Parameters<typeof language.t>[0], values)}
            loadSummary={(filters: FlightRecorderGlobalFilters) => loadFlightRecorderGlobalSummary(client, filters)}
            loadRows={(input: FlightRecorderGlobalRowsInput) => loadFlightRecorderGlobalRows(client, input)}
            loadWorkspaces={() => loadFlightRecorderGlobalWorkspaces(client)}
            onOpenSession={openSession}
          />
        </div>
      </div>
    </Dialog>
  )
}
