import type { WorkbenchAction, WorkbenchLayoutState } from '@/components/workbench/workbench-contract';

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M8 2.75v10.5" />
    </svg>
  );
}

export function F307WorkbenchTabs({
  layout,
  dispatch,
  onAddSurface,
  onActivateSurface,
  homeFocused,
}: {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  onAddSurface: () => void;
  onActivateSurface: () => void;
  homeFocused: boolean;
}) {
  const activeSurface = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId) ?? null;
  const splitCandidate = layout.surfaces.find((surface) => surface.id !== layout.activeSurfaceId) ?? null;

  return (
    <div
      className="flex min-h-10 shrink-0 items-stretch border-b border-cafe-subtle bg-cafe-surface"
      data-testid="f307-tab-actions"
    >
      <div
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-2 pt-1.5"
        role="tablist"
        data-testid="f307-tab-strip"
      >
        {layout.surfaces.map((surface, index) => {
          const active = !homeFocused && surface.id === layout.activeSurfaceId;
          const hasActivity = layout.activity.some((item) => item.surfaceId === surface.id);
          const pinned = layout.pinnedSurfaceIds.includes(surface.id);
          return (
            <div
              key={surface.id}
              className={`group flex max-w-[210px] shrink-0 items-center rounded-t-lg border border-b-0 px-1 transition-colors ${
                active
                  ? 'border-cafe-subtle bg-cafe-surface-elevated text-cafe'
                  : 'border-transparent text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-secondary'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  onActivateSurface();
                  dispatch({
                    type: 'activate-surface',
                    surfaceId: surface.id,
                    entitlement: { kind: 'user', reason: 'surface-tab' },
                  });
                  for (const item of layout.activity.filter((activity) => activity.surfaceId === surface.id)) {
                    dispatch({ type: 'dismiss-activity', activityId: item.id });
                  }
                }}
                className="flex min-w-0 items-center gap-1.5 px-2 py-2 text-xs font-medium"
                data-testid={`f307-tab-${surface.type}`}
              >
                {hasActivity && (
                  <>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--semantic-info)]" aria-hidden="true" />
                    <span className="sr-only">有新动态</span>
                  </>
                )}
                {surface.type === 'agent-run' && (
                  <span
                    className="shrink-0 rounded bg-cafe-surface-sunken px-1.5 py-0.5 text-micro font-semibold text-cafe-secondary"
                    data-testid="f307-tab-kind-agent-run"
                  >
                    运行
                  </span>
                )}
                <span className="truncate">{surface.title}</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: 'pin-surface',
                    surfaceId: surface.id,
                    pinned: !pinned,
                    entitlement: { kind: 'user', reason: 'surface-tab' },
                  })
                }
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-micro transition-colors hover:bg-cafe-surface-sunken ${
                  pinned ? 'text-cafe-accent' : 'text-cafe-muted'
                }`}
                aria-label={`${pinned ? '取消固定' : '固定'} ${surface.title}`}
                aria-pressed={pinned}
                data-testid={`f307-pin-${surface.type}`}
              >
                {pinned ? '◆' : '◇'}
              </button>
              {index > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    dispatch({
                      type: 'reorder-surface',
                      surfaceId: surface.id,
                      toIndex: index - 1,
                      entitlement: { kind: 'user', reason: 'surface-tab' },
                    })
                  }
                  className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-micro text-cafe-muted hover:bg-cafe-surface-sunken"
                  aria-label={`向左移动 ${surface.title}`}
                  data-testid={`f307-move-left-${surface.type}`}
                >
                  ←
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: 'close-surface',
                    surfaceId: surface.id,
                    entitlement: { kind: 'user', reason: 'close-button' },
                  })
                }
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe"
                aria-label={
                  surface.type === 'agent-run'
                    ? `从工作台收起 ${surface.title}（不会停止任务）`
                    : `关闭 ${surface.title}`
                }
                title={surface.type === 'agent-run' ? '从工作台收起，不会停止任务' : undefined}
                data-testid={`f307-close-${surface.type}`}
              >
                <span className="h-3.5 w-3.5">
                  <CloseIcon />
                </span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAddSurface}
          className={`mb-1.5 flex h-8 w-8 shrink-0 self-center items-center justify-center rounded-lg text-lg leading-none transition-colors ${
            homeFocused
              ? 'bg-cafe-surface-sunken text-cafe'
              : 'text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe'
          }`}
          aria-label="打开工作台主页"
          aria-pressed={homeFocused}
          title="打开工作台主页"
          data-testid="f307-add-surface"
        >
          +
        </button>
      </div>

      {layout.split === null && activeSurface !== null && splitCandidate !== null && (
        <div className="flex shrink-0 items-center border-l border-cafe-subtle px-1.5">
          <button
            type="button"
            onClick={() =>
              dispatch({
                type: 'split-with',
                surfaceId: splitCandidate.id,
                entitlement: { kind: 'user', reason: 'explicit-split' },
              })
            }
            className="flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe"
            aria-label={`与 ${splitCandidate.title} 并排`}
            title={`与 ${splitCandidate.title} 并排`}
            data-testid="f307-split"
          >
            <span className="h-4 w-4">
              <SplitIcon />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
