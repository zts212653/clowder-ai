export function WorkspaceHeader() {
  return (
    <>
      <div className="flex h-14 items-center gap-3 border-b border-cafe-subtle/60 px-4 sm:px-6">
        <span className="h-2.5 w-2.5 rounded-full bg-cafe-interactive" aria-hidden="true" />
        <span className="text-base font-semibold">Workspace</span>
      </div>
      <div className="flex min-h-16 items-center gap-3 border-b border-cafe-subtle/60 px-4 sm:px-6">
        <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-cafe-secondary" fill="none" stroke="currentColor">
          <title>返回</title>
          <path d="m15 18-6-6 6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="min-w-0">
          <span className="font-semibold">待确认</span>
          <span className="ml-3 text-sm text-cafe-muted">需要你看一眼再继续的事情</span>
        </div>
      </div>
    </>
  );
}

export function ApprovalChrome() {
  return (
    <>
      <div className="flex h-14 items-center justify-between border-b border-cafe-subtle/60 px-3 sm:px-5">
        <div className="flex h-full items-center gap-1">
          <button
            type="button"
            className="flex h-full items-center gap-2 border-b-2 border-cafe-interactive px-2 text-sm font-semibold"
          >
            等我确认
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--semantic-warning)] px-1 text-micro font-bold text-[var(--cafe-accent-foreground)]">
              9
            </span>
          </button>
          <button type="button" className="h-full px-3 text-sm font-medium text-cafe-muted">
            已处理
          </button>
        </div>
        <button type="button" className="rounded-lg p-2 text-cafe-secondary hover:bg-cafe-muted" aria-label="刷新">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor">
            <title>刷新</title>
            <path
              d="M20 12a8 8 0 1 1-2.3-5.7M20 4v6h-6"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-cafe-subtle/60 px-3 py-2 sm:px-5">
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border border-cafe px-3 py-1.5 text-xs font-medium"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor">
            <title>筛选</title>
            <path d="M4 6h16M7 12h10m-7 6h4" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          来源
        </button>
        <button type="button" className="rounded-lg px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-muted">
          暂不处理
        </button>
        <div className="min-w-[140px] flex-1 rounded-lg border border-cafe px-3 py-1.5 text-xs text-cafe-muted sm:max-w-52">
          搜索待确认事项…
        </div>
      </div>
    </>
  );
}
