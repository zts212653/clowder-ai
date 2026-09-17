import { useEffect, useRef } from 'react';
import type { WorkbenchAction, WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill={pinned ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
    >
      <path d="m8 2.25 5.75 5.75L8 13.75 2.25 8 8 2.25Z" />
    </svg>
  );
}

export function F307WorkbenchTab({
  surface,
  index,
  layout,
  active,
  dispatch,
  onActivateSurface,
  returnsFromMainArea = false,
  onExitMainAreaAttention,
}: {
  surface: WorkspaceSurfaceDescriptor;
  index: number;
  layout: WorkbenchLayoutState;
  active: boolean;
  dispatch: (action: WorkbenchAction) => void;
  onActivateSurface: () => void;
  returnsFromMainArea?: boolean;
  onExitMainAreaAttention: () => void;
}) {
  const activity = layout.activity.filter((item) => item.surfaceId === surface.id);
  const pinned = layout.pinnedSurfaceIds.includes(surface.id);
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tab = tabRef.current;
    if (!active || !tab || typeof tab.scrollIntoView !== 'function') return;

    const revealActiveTab = () => {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    revealActiveTab();

    const strip = tab.parentElement;
    if (!strip || typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(revealActiveTab);
    resizeObserver.observe(strip);
    return () => resizeObserver.disconnect();
  }, [active]);
  return (
    <div
      ref={tabRef}
      className={`group flex max-w-[210px] shrink-0 items-center rounded-t-lg border border-b-0 px-1 transition-colors ${active ? 'border-cafe-subtle bg-cafe-surface-elevated text-cafe' : 'border-transparent text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-secondary'}`}
      data-tab-surface-id={surface.id}
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
          for (const item of activity) dispatch({ type: 'dismiss-activity', activityId: item.id });
        }}
        className="flex min-w-0 items-center gap-1.5 px-2 py-2 text-xs font-medium"
        data-testid={`f307-tab-${surface.type}`}
      >
        {activity.length > 0 && (
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
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-cafe-surface-sunken ${pinned ? 'text-cafe-accent' : 'text-cafe-muted'}`}
        aria-label={`${pinned ? '取消固定' : '固定'} ${surface.title}`}
        aria-pressed={pinned}
        data-testid={`f307-pin-${surface.type}`}
      >
        <span className="h-3 w-3">
          <PinIcon pinned={pinned} />
        </span>
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
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-cafe-muted hover:bg-cafe-surface-sunken"
          aria-label={`向左移动 ${surface.title}`}
          data-testid={`f307-move-left-${surface.type}`}
        >
          <svg
            className="h-3 w-3"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m9.5 3-5 5 5 5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          if (returnsFromMainArea) {
            onExitMainAreaAttention();
            return;
          }
          dispatch({
            type: 'close-surface',
            surfaceId: surface.id,
            entitlement: { kind: 'user', reason: 'close-button' },
          });
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe"
        aria-label={
          returnsFromMainArea
            ? `返回侧栏 ${surface.title}`
            : surface.type === 'agent-run'
              ? `从工作台收起 ${surface.title}（不会停止任务）`
              : `关闭 ${surface.title}`
        }
        title={
          returnsFromMainArea
            ? '结束临时主区阅读，保留原 Workspace 页面'
            : surface.type === 'agent-run'
              ? '从工作台收起，不会停止任务'
              : undefined
        }
        data-testid={`f307-close-${surface.type}`}
      >
        <span className="h-3.5 w-3.5">
          <CloseIcon />
        </span>
      </button>
    </div>
  );
}
