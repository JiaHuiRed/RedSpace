import type { Session } from "@redcode-ai/sdk/v2/client"
import { createMemo, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Binary } from "@redcode-ai/core/util/binary"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query"
import { Spinner } from "@redcode-ai/ui/spinner"
import { ContextMenu } from "@redcode-ai/ui/context-menu"
import { Avatar as AvatarV2 } from "@redcode-ai/ui/v2/components/avatar-v2.jsx"
import { ButtonV2 } from "@redcode-ai/ui/v2/components/button-v2.jsx"
import { Icon as IconV2 } from "@redcode-ai/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@redcode-ai/ui/v2/components/icon-button-v2.jsx"
import { useGlobalSDK } from "@/context/global-sdk"
import { isCodeSession } from "@/utils/product-mode"
import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { DialogConfirm } from "@/components/dialog-confirm"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { useServer } from "@/context/server"
import { persisted } from "@/utils/persist"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { notifyServerError } from "@/utils/notify-error"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { displayName, getProjectAvatarSource, projectForSession, sortedRootSessions } from "@/utils/session-helpers"
import { pathKey } from "@/utils/path-key"
import { tallySessionStatus } from "@/utils/session-status"
import { pickGreetingKey } from "@/utils/greeting"
import { HomeKanban } from "@/pages/home-kanban"
import { HomeUsagePanel, readHomeUsageCollapsed } from "@/pages/home-usage"
import { focusProjectRow } from "@/pages/home-focus"

const HomeCompose = lazy(() => import("@/pages/home-compose"))

// 260710 Red 上游从 15 提到 64，修复"只显示 5 个会话"
const HOME_SESSION_LIMIT = 64
// 261123 Karina 侧栏「最近常用」默认展示数
const HOME_PROJECT_RECENT_LIMIT = 5
// 261123 Karina 分组的展开态走显式 localStorage（与 home-usage 的折叠态同一套）：
// persisted() 在 web dev 下实测刷新后读不回，而这条状态必须跨刷新保留。
const HOME_PROJECTS_EXPANDED_KEY = "redcode-home-projects-expanded"
function readProjectsExpanded() {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(HOME_PROJECTS_EXPANDED_KEY) === "1"
}
function writeProjectsExpanded(expanded: boolean) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(HOME_PROJECTS_EXPANDED_KEY, expanded ? "1" : "0")
}
const HOME_ROW =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] border-0 bg-transparent text-left [font-weight:530] text-v2-text-text-muted transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW} h-8 gap-1.5 px-2 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export default function Home(props: { initialDirectory?: string }) {
  const sync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const queryClient = useQueryClient()
  const command = useCommand()
  // 260616 Red 默认进看板视图（工作中/需关注/空闲）。
  // 261123 YuQi 列表视图与「新建会话」按钮下线：新建会话界面已并入首页 compose 区，
  //   这两个入口只剩「聚焦输入框」一个职责；看板成为唯一视图（view 字段、切换器、
  //   列表行组件一并移除）。
  // 260814 Red archived：归档只是打 time_archived 时间戳 + 列表默认过滤（session.ts 的 list），
  //   数据一个字节都不删。此前 GUI 只有"归档"没有"看已归档/取消归档"，归档等于单向消失——
  //   实测 432 个会话里只归档过 1 个。这里补齐可见性与撤销。
  const [state, setState] = createStore({
    search: "",
    project: undefined as string | undefined,
    archived: false,
    usageCollapsed: readHomeUsageCollapsed(),
  })
  // 261114 Red UX-09：回首页保留项目/视图/检索/归档筛选与位置（persisted 与默认值
  // 合并，新字段未来安全）。searchInputRef 焦点行为不变。
  persisted("home.view.state", [state, setState])
  let searchInputRef: HTMLInputElement | undefined
  const [focusRequest, requestComposerFocus] = createSignal(props.initialDirectory ? 1 : 0)
  const [pickedProject, setPickedProject] = createSignal<string>()

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        searchInputRef?.focus()
        searchInputRef?.select()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const projects = createMemo(() => layout.projects.list())
  const projectForDirectory = (directory: string | undefined) =>
    projects().find((project) => project.worktree === directory || (directory && project.sandboxes?.includes(directory)))
  const routeProject = createMemo(() => projectForDirectory(props.initialDirectory))
  const explicitProject = createMemo(() => projects().find((project) => project.worktree === pickedProject()))
  const selectedProject = createMemo(() => {
    const picked = explicitProject()
    if (picked) return picked
    if (props.initialDirectory) return routeProject()
    return projects().find((project) => project.worktree === state.project) ?? projects()[0]
  })
  const composerDirectory = () => explicitProject()?.worktree ?? props.initialDirectory ?? selectedProject()?.worktree
  const projectDirectories = createMemo(() => {
    const project = selectedProject()
    if (!project) return []
    return [project.worktree, ...(project.sandboxes ?? [])]
  })
  const search = createMemo(() => state.search.trim())
  // 260707 Red loadSessions() 对每个目录都是真实 session.list HTTP 请求——服务端
  //   instance-context 中间件对任何带 directory 的路由都会触发该目录整套 InstanceStore.load()
  //   (MCP/LSP/watcher 全起)，client 端的 {bootstrap:false} 只影响本地是否连 query，拦不住这个。
  //   之前对 projectDirectories()（含全部 sandboxes/worktree）一次性 Promise.all 全部 loadSessions，
  //   等于选中项目有几个 sandbox 就同时拉起几套完整 MCP/LSP 进程树——这是"打开即多目录内存/
  //   进程风暴"里独立于 enrich()/titlebar 之外的第三个真正源头。首页只需要主 worktree 的
  //   session 保证可见；sandbox 的 session 只在真被用户展开/进入时才应该真正 bootstrap，
  //   这里改为只主动加载主 worktree，sandbox 一律 peek 只读缓存，不强制拉起。
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", selectedProject()?.worktree] as const,
    // 261002 Red 同项目首载失败后回首页不再触发任何请求，会话列表永远空白。局部放开
    //   挂载重取自愈，30s 内不重复打请求。
    staleTime: 30_000,
    refetchOnMount: true,
    queryFn: async () => {
      const project = selectedProject()
      if (project) await sync.project.loadSessions(project.worktree)
      return null
    },
  }))

  // 260814 Red 已归档会话不进 sync store（global-sync 拉取时就滤掉了），只能单独取。
  const archivedLoad = useInfiniteQuery(() => {
    const project = selectedProject()
    const directory = project?.worktree
    const query = search()
    const keyword =
      project && displayName(project).toLowerCase().includes(query.toLowerCase()) ? undefined : query || undefined
    return {
      queryKey: ["home", "archived", directory, keyword] as const,
      enabled: state.archived && !!directory,
      // 261002 Red 同 sessionLoad：开关翻回来时若首载已失败，不放开就永远空列表。
      staleTime: 30_000,
      refetchOnMount: true,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page: { next?: string }) => page.next,
      queryFn: async ({ pageParam, signal }) => {
        const res = await globalSDK.client.experimental.session.list(
          {
            directory,
            roots: true,
            archivedOnly: true,
            mode: "code",
            search: keyword,
            cursor: pageParam,
            limit: HOME_SESSION_LIMIT,
          },
          { throwOnError: true, signal },
        )
        return { sessions: res.data, next: res.response.headers.get("x-next-cursor") ?? undefined }
      },
    }
  })

  const boardQuery = () => (state.archived ? archivedLoad : sessionLoad)

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const records = createMemo(() =>
    [
      ...new Map(
        (state.archived
          ? (archivedLoad.data?.pages.flatMap((page) => page.sessions) ?? [])
          : projectDirectories().flatMap((directory) =>
              sortedRootSessions(sync.child(directory, { bootstrap: false })[0], Date.now()),
            )
        ).map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
      ).values(),
    ]
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .flatMap((session) => {
        const project = projectForSession(session, projects(), projectByID())
        if (!project) return []
        return {
          session,
          project,
          projectName: displayName(project),
        }
      })
      .filter((record) => isCodeSession(record.session))
      .filter((record) => {
        const value = search().toLowerCase()
        if (!value) return true
        return `${record.session.title} ${record.projectName}`.toLowerCase().includes(value)
      })
      .slice(0, state.archived ? undefined : HOME_SESSION_LIMIT),
  )
  // 260701 Red 首页左下角看板用：跟 records() 不一样，不做 15 条截断、不排除子 session
  // （子 agent worktree session 也有独立 cost/tokens，不算进去总花费会偏低）。
  const statsSessions = createMemo(() =>
    projectDirectories().flatMap((directory) => {
      const store = sync.child(directory, { bootstrap: false })[0]
      return (store.session ?? []).filter(
        (session) =>
          isCodeSession(session) && pathKey(session.directory) === pathKey(directory) && !session.time?.archived,
      )
    }),
  )

  function selectProject(directory: string) {
    if (!projects().some((project) => project.worktree === directory)) return
    setPickedProject(directory)
    setState("project", directory)
  }

  function addProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    setPickedProject(directory)
    setState("project", directory)
  }

  function openNewSession() {
    if (!composerDirectory()) {
      void chooseProject()
      return
    }
    requestComposerFocus((count) => count + 1)
  }

  command.register("code-home", () => [
    {
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      onSelect: openNewSession,
    },
  ])

  function openSession(session: Session, focus?: "prompt") {
    const project = projectForSession(session, projects(), projectByID())
    layout.projects.open(project?.worktree ?? session.directory)
    server.projects.touch(project?.worktree ?? session.directory)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}${focus ? "?focus=prompt" : ""}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        result.forEach(addProject)
        if (result[0]) {
          setPickedProject(result[0])
          setState("project", result[0])
          requestComposerFocus((count) => count + 1)
        }
        return
      }
      if (result) {
        addProject(result)
        requestComposerFocus((count) => count + 1)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
      return
    }

    dialog.show(
      () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  function openSettings() {
    void import("@/components/dialog-settings").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  // 261106 Red 移除项目加二次确认：右键菜单一点直接 project.remove 不可恢复。
  function removeProject(project: LocalProject) {
    const doRemove = async () => {
      // 261106 Red SDK 默认不因 HTTP 错误抛异常（无 throwOnError 时返回 error 对象），
      // try/catch 拦不到 4xx/5xx；服务端确认成功前不得关闭本地项目。
      if (project.id && project.id !== "global") {
        try {
          await globalSDK.client.project.remove({ projectID: project.id }, { throwOnError: true })
        } catch (err) {
          notifyServerError(language.t, err)
          return
        }
      }
      layout.projects.close(project.worktree)
      if (state.project === project.worktree) setState("project", undefined)
    }
    dialog.show(() => (
      <DialogConfirm
        title={language.t("dialog.confirm.removeProject.title")}
        description={language.t("dialog.confirm.removeProject.description", { project: project.name || project.worktree })}
        onConfirm={() => void doRemove()}
      />
    ))
  }

  // 260710 Red 归档会话：标记 archived 时间戳，isRootVisibleSession 自动过滤
  // 260814 Red 修「点了没反应」：原来既没传 directory 也没动本地 store。
  //   1) session.update 是实例级路由，缺 directory 时服务端回落 process.cwd()
  //      （workspace-routing.ts 的 defaultDirectory），于是 session.updated 事件
  //      被发到那个目录的频道上，首页按 session.directory 分片的 store 永远收不到；
  //   2) 即便事件到了也该先落本地——directory-sync 的 archive 就是「调 API + 立即
  //      从 store 摘掉」两步，这里对齐它。
  function dropFromStore(session: Session) {
    const [, setStore] = sync.child(session.directory)
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
  }

  async function archiveSession(session: Session) {
    // 261106 Red 归档失败不再静默：此前无 catch，rejection 无人消费，界面零反馈。
    // 261106 Red 加 throwOnError：SDK 对 HTTP 4xx/5xx 默认不抛异常，catch 拦不到，
    // 服务端失败时会误删本地会话记录（刷新后又出现）。
    try {
      await globalSDK.client.session.update(
        {
          sessionID: session.id,
          directory: session.directory,
          time: { archived: Date.now() },
        },
        { throwOnError: true },
      )
    } catch (err) {
      notifyServerError(language.t, err)
      return
    }
    dropFromStore(session)
    void queryClient.invalidateQueries({ queryKey: ["home", "archived", session.directory] })
  }

  // 260814 Red 取消归档：清掉 time_archived，会话立刻回到正常列表。
  //   用独立的 unarchive 字段而非 time.archived:null——原因见服务端 UpdatePayload 的注释
  //   （OpenAPI 生成器会把 payload 里的联合类型压平，null 传不过来）。
  //   取消后刷新归档列表，让它从"已归档"视图里消失。
  async function unarchiveSession(session: Session) {
    // 261106 Red 取消归档失败同样给出反馈（本地 store 未变，失败后列表与真实状态一致）。
    // 261106 Red 加 throwOnError：HTTP 失败默认不抛异常，否则失败后仍继续刷新列表，
    // 呈现与服务端不一致的状态。
    try {
      await globalSDK.client.session.update(
        {
          sessionID: session.id,
          directory: session.directory,
          unarchive: true,
        },
        { throwOnError: true },
      )
    } catch (err) {
      notifyServerError(language.t, err)
      return
    }
    await queryClient.invalidateQueries({ queryKey: ["home", "archived", session.directory] })
    // 让它重新出现在正常列表里（归档时已从 store 摘掉，事件回不来就得主动拉）
    await sync.project.loadSessions(session.directory)
  }

  return (
    <div
      data-component="home-dashboard"
      class="grid h-full w-full grid-rows-[auto_minmax(0,1fr)_auto] gap-x-6 pr-2 lg:grid-cols-[232px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto] lg:pr-6"
    >
      <HomeProjectColumn
        projects={projects()}
        selected={selectedProject()?.worktree}
        selectProject={selectProject}
        chooseProject={() => void chooseProject()}
        openSettings={openSettings}
        removeProject={(project) => void removeProject(project)}
        language={language}
        statsSessions={statsSessions()}
      />

      <section
        class="@container min-h-0 min-w-0 overflow-y-auto pt-6 pr-2"
        aria-label={language.t("sidebar.project.recentSessions")}
      >
        {/* 261124 六轮（哥哥定稿）：左右整体互换——compose（字标+输入框+继续任务）是主视觉，
            挪到左侧阅读起点；搜索+归档+用量面板的工作台列挪到右侧。看板带随之靠右
            （board-section 里 justify-end，右缘与工作台列对齐）。
            变量 --compose-max-w 由这里下传，session-new-design-view 内部消费。 */}
        <div class="flex flex-col gap-x-6 pr-2 @min-[1040px]:flex-row @min-[1040px]:items-start">
          <div
            data-component="home-compose-section"
            class="flex min-w-0 justify-center pt-10 pb-[clamp(26px,4vh,44px)] @min-[1040px]:flex-1"
            style={{ "--compose-max-w": "900px" }}
          >
            <Show when={composerDirectory()} keyed>
              {(directory) => (
                <div class="w-full max-w-[var(--compose-max-w,720px)]">
                  <Suspense fallback={<div class="min-h-40" aria-busy="true" />}>
                    <HomeCompose
                      directory={directory}
                      onProjectChange={selectProject}
                      onSubmit={() => {
                        const project = projectForDirectory(directory)?.worktree ?? directory
                        layout.projects.open(project)
                        server.projects.touch(project)
                      }}
                      focusRequest={focusRequest()}
                    />
                  </Suspense>
                </div>
              )}
            </Show>
          </div>
          {/* 261124 八轮：列宽 620→720 配合看板带宽——面板左移 100px，右列与看板同宽等右缘。 */}
          <div class="flex w-full shrink-0 flex-col gap-3 @min-[1040px]:w-[min(720px,calc(100%-460px))]">
            <div class="flex items-center gap-2">
              <HomeSessionSearch
                ref={(el) => (searchInputRef = el)}
                value={state.search}
                placeholder={language.t("home.sessions.search.placeholder")}
                onInput={(value) => setState("search", value)}
              />
              {/* 260814 Red 已归档视图开关：打开后看板换成归档会话（单独请求，见 archivedLoad）。
                  261123 YuQi 搜索栏旁的「新建会话」按钮与视图切换器下线——新建会话界面已并入
                  首页 compose 区，按钮只剩聚焦输入框；列表视图移除后看板是唯一视图。 */}
              <IconButtonV2
                data-action="home-toggle-archived"
                variant={state.archived ? "contrast" : "ghost-muted"}
                size="large"
                icon={<IconV2 name="archive" size="small" />}
                onClick={() => setState("archived", !state.archived)}
                aria-label={language.t("home.sessions.archived.toggle")}
                aria-pressed={state.archived}
                class="size-7 shrink-0"
              />
            </div>
            <HomeUsagePanel
              directory={selectedProject()?.worktree}
              collapsed={state.usageCollapsed}
              onCollapsedChange={(collapsed) => setState("usageCollapsed", collapsed)}
            />
          </div>
        </div>
        <div data-component="home-board-section" class="pt-2 pb-5">
          <Show when={!boardQuery().isLoading} fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}>
            <Show when={boardQuery().isError}>
              <div role="alert" class="flex items-center justify-center gap-2 py-3">
                {language.t("common.requestFailed")}
                <ButtonV2
                  onClick={() =>
                    void (state.archived && archivedLoad.isFetchNextPageError
                      ? archivedLoad.fetchNextPage()
                      : boardQuery().refetch())
                  }
                >
                  {language.t("common.retry")}
                </ButtonV2>
              </div>
            </Show>
            <Show
              when={records().length > 0}
              fallback={boardQuery().isError ? undefined : (
                <div class="flex min-w-0 flex-col items-center gap-4 py-12">
                  <div class="flex size-12 items-center justify-center rounded-full bg-v2-background-bg-deep">
                    <IconV2 name="edit" size="large" class="text-v2-text-text-muted" />
                  </div>
                  <div class="flex flex-col items-center gap-1 text-center">
                    <div class="text-14-normal font-medium text-v2-text-text-base">
                      {language.t(state.archived ? "home.sessions.archived.empty" : "home.sessions.empty")}
                    </div>
                    <Show when={!state.archived}>
                      <div class="text-12-regular text-v2-text-text-muted">{language.t("command.session.new")}</div>
                    </Show>
                  </div>
                  {/* 归档视图为空时不提示"新建会话"——那不是这个视图该做的事 */}
                  <Show when={!state.archived}>
                    <ButtonV2
                      data-action="home-new-session-empty"
                      variant="contrast"
                      size="normal"
                      icon="edit"
                      class="mt-2"
                      onClick={openNewSession}
                    >
                      {language.t("command.session.new")}
                    </ButtonV2>
                  </Show>
                </div>
              )}
            >
              {/* 261124 六轮：工作台挪右后，看板带靠右（justify-end），右缘与工作台列对齐
                  （pr-2 对齐顶部行的同一缩进）；空态与骨架保持全宽居中，不跟着靠右。 */}
              <div class="flex justify-end pr-2">
                <HomeKanban
                  records={records()}
                  selectedProjectName={selectedProject() ? displayName(selectedProject()!) : undefined}
                  openSession={openSession}
                  onArchive={archiveSession}
                  onUnarchive={(session) => void unarchiveSession(session)}
                  showAllIdle={state.archived || search().length > 0}
                />
              </div>
            </Show>
            <Show when={state.archived && archivedLoad.hasNextPage && !archivedLoad.isError}>
              <div class="flex justify-end pr-2 pt-3">
                <ButtonV2 disabled={archivedLoad.isFetching} onClick={() => void archivedLoad.fetchNextPage()}>
                  {language.t(archivedLoad.isFetchingNextPage ? "common.loading" : "common.loadMore")}
                </ButtonV2>
              </div>
            </Show>
          </Show>
        </div>
      </section>
      {/* 260709 Red 首页底部快捷键提示条 */}
      <HomeShortcutBar showGreeting={!composerDirectory()} />
    </div>
  )
}

// 260710 Red 首页底部：随机 tips + 快捷键提示条
// 260811 Red 只占内容列（lg:col-start-2），侧边栏跨两行延伸到底
// 260828 cc 轮播 tips 整套下线，换成与新建会话页同一组按时段问候（utils/greeting）。
//
// 下线的东西与理由：
// · **每 20 分钟一次 /experimental/generate 调用** —— 为了一行装饰文字，在常驻界面上
//   持续烧模型调用。这是本轮唯一一处「界面自己主动花钱」的地方。
// · **50 条本地 tips 库** —— 其中约七条教的快捷键正下方那行图例里就写着，本来就是重复；
//   而且它此前实际是死的（memo 里的 Math.random() 只在挂载时抽一次，几秒后就被生成的
//   那条永久顶掉），今天上午刚修好又整个删掉，前后不到半天。
// · 随之删掉的还有我上午为了消重复而写的 shortcutKeys 过滤 —— 换成问候语之后，
//   与快捷键条重复这件事从根上不存在了，那段代码没了存在理由。
function HomeShortcutBar(props: { showGreeting: boolean }) {
  const language = useLanguage()
  const command = useCommand()
  // 261106 Red UX-03：提示条改从命令系统读取真实绑定（含用户自定义），
  // 只保留高频 6 条，未注册/被设为 none 的动作不渲染，避免展示过期快捷键。
  const shortcuts = [
    { id: "command.palette", label: language.t("home.shortcuts.commandPalette") },
    { id: "session.new", label: language.t("home.shortcuts.newSession") },
    { id: "project.open", label: language.t("home.shortcuts.openProject") },
    { id: "session.previous", label: language.t("home.shortcuts.switchSession") },
    { id: "project.previous", label: language.t("home.shortcuts.switchProject") },
    { id: "settings.open", label: language.t("home.shortcuts.settings") },
  ]
  const items = () =>
    shortcuts.flatMap((item) => {
      const keys = command.keybind(item.id)
      return keys ? [{ keys, label: item.label }] : []
    })
  // 进页面抽一次。用 createSignal 不用 createMemo —— 理由见 utils/greeting.ts。
  const [greetingKey] = createSignal(pickGreetingKey(new Date().getHours()))
  const tip = () => language.t(greetingKey())

  // 260810 cc audit R9: 原硬编码 #4ade80 带 60%/80% alpha，浅色三主题（light/cream/green)
  // 下对比度约 1.5:1 基本不可读；改语义 token（明 green-800/暗 green-500）保住绿色系
  // 人格化设计且随主题走。快捷键行补 flex-wrap，窄窗不再溢出裁切。
  return (
    <div class="col-span-full lg:col-start-2 flex flex-col items-center gap-1.5 px-4 pt-2 pb-3">
      <Show when={props.showGreeting}>
        <span class="text-[14px] [font-weight:440] italic text-v2-state-fg-success">{tip()}</span>
      </Show>
      <div class="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-[13px] [font-weight:440] text-v2-state-fg-success">
        <For each={items()}>
          {(item) => (
            <span class="flex items-center gap-1">
              <span class="text-[12px] [font-weight:530]">{item.keys}</span>
              <span>{item.label}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  )
}

function HomeProjectColumn(props: {
  projects: LocalProject[]
  selected?: string
  selectProject: (directory: string) => void
  chooseProject: () => void
  openSettings: () => void
  removeProject: (project: LocalProject) => void
  language: ReturnType<typeof useLanguage>
  statsSessions: Session[]
}) {
  const platform = usePlatform()
  const server = useServer()

  // 261123 Karina 项目列表分组：最近常用 + 全部折叠。
  // 顺序直接沿用 server.projects 的 touch 冒泡（最近打开在前），不新增数据源。
  // 三条边界：选中项掉出前 5 时强制补位（选中态已有品牌描边，不再加「当前」标签）；
  // 展开后不重复前 5；项目 ≤5 时整个分组隐藏。
  const [projectsExpanded, setProjectsExpanded] = createSignal(readProjectsExpanded())
  const toggleProjectsExpanded = () => {
    const next = !projectsExpanded()
    setProjectsExpanded(next)
    writeProjectsExpanded(next)
  }
  const recent = createMemo(() => {
    const all = props.projects
    if (all.length <= HOME_PROJECT_RECENT_LIMIT) return all
    const head = all.slice(0, HOME_PROJECT_RECENT_LIMIT)
    if (!props.selected || head.some((project) => project.worktree === props.selected)) return head
    const current = all.find((project) => project.worktree === props.selected)
    return current ? [...all.slice(0, HOME_PROJECT_RECENT_LIMIT - 1), current] : head
  })
  const rest = createMemo(() => {
    const shown = new Set(recent().map((project) => project.worktree))
    return props.projects.filter((project) => !shown.has(project.worktree))
  })
  const grouped = createMemo(() => rest().length > 0)
  // 261122 Red 第三批：键盘（或鼠标）激活「全部项目」里的条目后，选中态会让它补位到
  // 「最近常用」，原按钮随分组迁移卸载，焦点掉回 body。重排后把焦点交给同一项目的新
  // 按钮；用户已经点去别处时不抢（判据见 home-focus.ts）。
  const restoreProjectFocus = (worktree: string) => {
    const directory = base64Encode(worktree)
    requestAnimationFrame(() => {
      focusProjectRow(directory)
    })
  }
  const renderProject = (project: LocalProject) => (
    <ContextMenu>
      <ContextMenu.Trigger
        as="button"
        type="button"
        data-component="home-project-row"
        data-action="home-project-row"
        data-project={base64Encode(project.worktree)}
        class={HOME_PROJECT_NAV_ROW}
        classList={{ "bg-v2-overlay-simple-overlay-hover": props.selected === project.worktree }}
        data-selected={props.selected === project.worktree ? "" : undefined}
        aria-current={props.selected === project.worktree ? "page" : undefined}
        onClick={() => {
          restoreProjectFocus(project.worktree)
          props.selectProject(project.worktree)
        }}
      >
        <HomeProjectAvatar project={project} />
        <span>{displayName(project)}</span>
        <HomeProjectStatus project={project} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          {/* 260710 Red 在文件管理器中打开项目目录 */}
          <Show when={platform.platform === "desktop" && platform.openPath && server.isLocal()}>
            <ContextMenu.Item
              data-action="home-project-reveal"
              data-project={base64Encode(project.worktree)}
              onSelect={() => void platform.openPath?.(project.worktree).catch((error) => notifyServerError(props.language.t, error))}
            >
              <ContextMenu.ItemLabel>{props.language.t("home.project.revealInExplorer")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </Show>
          <ContextMenu.Item
            data-action="home-project-remove"
            data-project={base64Encode(project.worktree)}
            onSelect={() => props.removeProject(project)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.delete")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
  return (
    // 260829 cc 侧栏从「贴边到底的柱子」改成浮起的卡片。
    //   起因：哥哥说看板卡片的玻璃质感明显比侧栏好，而看板卡片**根本没有玻璃**
    //   （bg-v2-background-bg-base 是实色，零 backdrop-filter），真磨砂在侧栏这边。
    //   差的是物体性不是光学：卡片有圆角、四边描边、阴影、浮在磨砂主卡之上；侧栏只有
    //   一条 border-r，贴边到底，眼睛读成墙——墙再通透也不是玻璃。
    //   所以杠杆不是把 68%/blur18 往上推（推到 --frost-strength 1.39 还会整块钳成不透明），
    //   而是让它成为一个看得见四条边的物件：脱边留白 + 14px 圆角 + 四边描边 + 向下阴影。
    //   border-r 与 pr-6 一并撤掉——前者是「墙」的边界语言，后者是墙与内容的间距，
    //   成卡之后由 px-3 与栅格的 gap-x-6 接手。
    //   列宽 220→232 是补偿：ml-3(12) + px-3 两侧(24) 之后内容仍是 196px，与改前一致，
    //   免得项目名截断变化混进观感判断里。
    //
    //   260829 cc 二轮，哥哥说「不算严丝合缝」。量出来两处：
    //   · 原来的 pt-[52px] 是把内容顶到 52px，与内容列 <section> 的 pt-12(48px) 对齐过——
    //     搜索框和「项目」标题是一条线上的。第一版写成 mt-[52px] + p-3，内容落到 64px，
    //     整整低了 12px，那条线就断了。
    //   · 上边距 42px、左右下 12px。那 42px 不是新加的，是页面本来的顶部呼吸带，但侧栏
    //     成卡之后它就读成一个大得离谱的上边距。
    //   改法是把这两件事拆开：卡片上提到 mt-3，三边留白统一 12px；内容靠卡片**内部**的
    //   pt-10(40px) 顶回 12+40=52px，与改造前逐像素相同。卡顶因此高于搜索框一截——
    //   这正是 Aqua 那种侧栏卡的样子，不是失误。
    <aside
      class="flex max-h-[23dvh] min-w-0 flex-col overflow-y-auto lg:row-span-full lg:max-h-none lg:mt-3 lg:mb-3 lg:ml-3 lg:rounded-pane lg:border lg:border-v2-border-border-base lg:bg-v2-background-bg-layer-01 lg:px-3 lg:pb-3 lg:pt-10 lg:shadow-[var(--v2-elevation-floating)]"
      data-frost-surface="home-sidebar"
      aria-label={props.language.t("home.projects")}
    >
      <div class="flex h-7 min-w-0 items-center justify-between pl-2">
        <div class={HOME_SECTION_LABEL}>{props.language.t("home.projects")}</div>
        <IconButtonV2
          data-action="home-add-project"
          variant="ghost-muted"
          size="large"
          class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
          icon={<IconV2 name="folder-add-left" />}
          onClick={props.chooseProject}
          aria-label={props.language.t("home.project.add")}
        />
      </div>
      {/* 260709 Red 项目列表占据剩余空间，flex-1 + min-h-0 让列表自适应高度 */}
      <div class="mt-4 flex flex-1 min-h-0 min-w-0 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Show
          when={props.projects.length > 0}
          fallback={
            <button
              type="button"
              class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
              onClick={props.chooseProject}
            >
              <IconV2 name="folder-add-left" size="small" />
              <span>{props.language.t("home.project.add")}</span>
            </button>
          }
        >
          <Show when={grouped()}>
            <div class="px-2 pb-1 pt-1 text-[11px] [font-weight:440] text-v2-text-text-faint">
              {props.language.t("home.projects.recent")}
            </div>
          </Show>
          <For each={recent()}>{renderProject}</For>
          <Show when={grouped()}>
            <button
              type="button"
              data-action="home-projects-toggle"
              class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint`}
              aria-expanded={projectsExpanded()}
              onClick={toggleProjectsExpanded}
            >
              <span>{props.language.t("home.projects.all")}</span>
              <span class="shrink-0 rounded-full bg-v2-overlay-simple-overlay-hover px-1.5 text-[10px] tabular-nums">
                {rest().length}
              </span>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                class="ml-auto size-3 shrink-0 transition-transform duration-[160ms]"
                classList={{ "rotate-180": projectsExpanded() }}
              >
                <path
                  d="M5.5 8l4.5 4.5L14.5 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
             <Show when={projectsExpanded()}>
              <For each={rest()}>{renderProject}</For>
            </Show>
          </Show>
        </Show>
      </div>
      {/* 260709 Red 左栏底部吸底：StatsPanel + 设置按钮固定在左栏最下方，不随项目列表滚动 */}
      {/* 260901 cc StatsPanel 搬到主区会话卡下方（HomeUsagePanel 里）——左栏 232px 放不下看板，
          而主区会话卡以下本来就是一大片空白。这里只剩设置按钮。 */}
      <div class="mt-auto shrink-0">
        <div class="mt-2 flex min-w-0 flex-col gap-1">
          <button
            type="button"
            class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
            onClick={props.openSettings}
          >
            <IconV2 name="settings-gear" size="small" />
            <span>{props.language.t("sidebar.settings")}</span>
          </button>
        </div>
      </div>
    </aside>
  )
}

// 260828 cc 项目行的运行态指示。
//
// 12 个项目排在侧边栏里，此前只有色块头像 + 名字 —— 哪个有会话在跑、哪个有权限请求
// 等着你，必须逐个点进去才知道。而看板早就把这个分类算出来了（现在两边共用
// @/utils/session-status 的判据）。
//
// **必须用 peek 不是 child**：`child()` 无条件 pinForOwner，把目录永久钉住，重连时
// 「只刷新 pinned 目录」的过滤形同虚设（layout.tsx 的 enrich() 上方那条注释记的就是这个
// 坑）。首个版本用了 child，侧边栏对 12 个项目各调一次，实测触发 12 次串行 session.list、
// 累计 28 秒 —— 期间首页一条会话都显示不出来。`peek()` 只读已经在内存里的 store，不 pin、
// 不触发 InstanceStore.load()。代价是从没打开过的项目这里什么都不显示 —— 那是对的，
// 我们确实不知道，也不该为了点亮一个小点去把整套 MCP/LSP 进程树拉起来。
function HomeProjectStatus(props: { project: LocalProject }) {
  const sync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const tally = createMemo(() => {
    const [store] = sync.peek(props.project.worktree, { bootstrap: false })
    const sessions = (store.session ?? []).filter((session) => !session.time?.archived)
    if (sessions.length === 0) return undefined
    return tallySessionStatus(sessions, { sync, notification, permission })
  })
  return (
    <span class="ml-auto flex shrink-0 items-center gap-1.5">
      <Show when={(tally()?.working ?? 0) > 0}>
        <Spinner class="size-[11px] text-v2-icon-icon-info" />
      </Show>
      <Show when={(tally()?.attention ?? 0) > 0}>
        <span class="flex items-center gap-1 text-[11px] [font-weight:530] text-v2-icon-icon-warning">
          <span class="size-1.5 rounded-full bg-surface-warning-strong" />
          {tally()!.attention}
        </span>
      </Show>
    </span>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <AvatarV2
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      kind="org"
      size="small"
      {...getAvatarColors(props.project.icon?.color)}
      class="size-4 rounded"
    />
  )
}

function HomeSessionSearch(props: {
  ref?: (el: HTMLInputElement) => void
  value: string
  placeholder: string
  onInput: (value: string) => void
}) {
  const isMac = navigator.platform.includes("Mac")
  const modKey = isMac ? "⌘" : "Ctrl"
  let inputRef: HTMLInputElement | undefined
  return (
    <label
      data-component="home-session-search"
      // 261123 YuQi 搜索栏不再横跨整屏。261124 布局重排后宽度由所在列统一控制。
      // 261124 YuQi 底色对齐用量面板/看板卡片的淡紫层色（bg-layer-01 半透明，透出壁纸），
      // 聚焦不再切回实色 bg-base，只保留 focus 描边阴影。
      class="ml-4 flex h-9 min-w-0 flex-1 sticky top-0 inset-x-0 items-center gap-2 rounded-[6px] bg-v2-background-bg-layer-01 px-3 py-1 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)]"
    >
      <IconV2 name="magnifying-glass" size="small" />
      <input
        ref={(el) => {
          inputRef = el
          props.ref?.(el)
        }}
        class="min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <kbd class="hidden sm:inline-flex items-center gap-0.5 rounded border border-v2-border-border-base px-1.5 py-0.5 text-[10px] font-medium text-v2-text-text-muted tabular-nums">
        {modKey}+K
      </kbd>
    </label>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}
