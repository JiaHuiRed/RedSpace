// 261122 Red 第三批：首页项目行的焦点恢复。
// 选中态会把项目从「全部项目」补位到「最近常用」，原按钮随分组迁移卸载、焦点掉回
// body。重排后按项目身份定位新按钮；用户已经点去别处（焦点仍在其它已挂载元素、
// 或停在原按钮上）时不抢焦点。
export function focusProjectRow(directory: string, root: ParentNode = document) {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.isConnected && active !== document.body) return false
  const next = [...root.querySelectorAll<HTMLElement>('[data-component="home-project-row"]')].find(
    (button) => button.dataset.project === directory,
  )
  if (!next) return false
  next.focus()
  return true
}
