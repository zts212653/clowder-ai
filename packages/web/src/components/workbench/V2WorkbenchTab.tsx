'use client';

import { AppTooltip } from '@/components/AppTooltip';
import { useMeasuredOverflow } from '@/components/content-overflow/useMeasuredOverflow';
import { MemoryBookStarIcon, ShellGlyph, YarnBallIcon } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { HOME_ROWS } from '@/components/workspace-home/home-rows';
import type { F307WorkbenchTabsProps } from './F307WorkbenchTabs';
import { resolveWorkspaceDestinationTarget } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';

function WorkbenchTabIcon({ surface }: { surface: WorkspaceSurfaceDescriptor }) {
  const destination = resolveWorkspaceDestinationTarget(surface);
  const toolIcon = HOME_ROWS.find((row) => row.id === destination?.destinationRef)?.icon;
  const iconClassName = 'ml-1 h-3 w-3 shrink-0';
  if (toolIcon === 'yarnBall') return <YarnBallIcon className={iconClassName} />;
  if (toolIcon === 'memory') return <MemoryBookStarIcon className={iconClassName} />;
  if (toolIcon) return <ShellGlyph name={toolIcon} className={iconClassName} />;
  const paths =
    surface.type === 'browser'
      ? 'M2 3h12v10H2zM2 6h12'
      : surface.type === 'terminal'
        ? 'm3 4 4 4-4 4m5 0h5'
        : surface.type === 'artifact' || surface.type === 'review'
          ? 'M2 2h12v12H2zm1 9 3-3 2 2 3-4 2 5'
          : 'M4 2h5l3 3v9H4zM9 2v3h3';
  return (
    <svg className={iconClassName} viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      <path d={paths} />
    </svg>
  );
}

/** The chrome names and detaches the original owner; it never closes the underlying work. */
export function V2WorkbenchTab({
  surface,
  displayTitle = surface.title,
  props,
  menu = false,
  onDone,
}: {
  surface: WorkspaceSurfaceDescriptor;
  displayTitle?: string;
  props: F307WorkbenchTabsProps;
  menu?: boolean;
  onDone?: () => void;
}) {
  const t = useShellCopy(workspaceChromeCopy);
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({ axis: 'inline' });
  const active = !props.homeFocused && surface.id === props.layout.activeSurfaceId;
  const pinned = props.layout.pinnedSurfaceIds.includes(surface.id);
  return (
    <div
      className={`group flex min-w-0 items-center rounded-md border ${menu ? 'w-full' : 'max-w-[150px] shrink-0'} ${active ? 'border-[var(--shell-hairline-strong)] bg-cafe-surface-sunken text-cafe' : 'border-transparent text-cafe-muted'}`}
      data-tab-surface-id={surface.id}
      data-surface-type={surface.type}
    >
      <WorkbenchTabIcon surface={surface} />
      <AppTooltip label={displayTitle} disabled={!overflowing} multiline side="bottom">
        <button
          type="button"
          {...(menu ? { 'aria-pressed': active } : { role: 'tab', 'aria-selected': active })}
          data-tool-surface-id={surface.id}
          data-workbench-tab-control="activate"
          className="min-w-0 flex-1 px-1 py-2 text-left text-xs"
          onDoubleClick={() =>
            props.dispatch({
              type: 'promote-preview-surface',
              surfaceId: surface.id,
              entitlement: { kind: 'user', reason: 'surface-tab' },
            })
          }
          onClick={() => {
            props.dispatch({
              type: 'activate-surface',
              surfaceId: surface.id,
              entitlement: { kind: 'user', reason: 'surface-tab' },
            });
            props.onActivateSurface();
            for (const item of props.layout.activity)
              if (item.surfaceId === surface.id) props.dispatch({ type: 'dismiss-activity', activityId: item.id });
            onDone?.();
          }}
        >
          <span ref={ref} className={`block truncate ${props.layout.previewSurfaceId === surface.id ? 'italic' : ''}`}>
            {displayTitle}
          </span>
        </button>
      </AppTooltip>
      {(active || menu) && (
        <AppTooltip label={pinned ? t.unpin : t.pin} side="bottom">
          <button
            type="button"
            aria-label={`${pinned ? t.unpin : t.pin} ${displayTitle}`}
            data-workbench-tab-control="pin"
            className="h-7 w-7 shrink-0 rounded text-xs hover:bg-cafe-surface-elevated"
            onClick={() =>
              props.dispatch({
                type: 'pin-surface',
                surfaceId: surface.id,
                pinned: !pinned,
                entitlement: { kind: 'user', reason: 'surface-tab' },
              })
            }
          >
            {pinned ? '◆' : '◇'}
          </button>
        </AppTooltip>
      )}
      <AppTooltip label={t.closeTab(displayTitle)} side="bottom">
        <button
          type="button"
          aria-label={t.closeTab(displayTitle)}
          data-testid="v2-close-tab"
          data-workbench-tab-control="close"
          className="h-7 w-5 shrink-0 rounded hover:bg-cafe-surface-elevated"
          onClick={() => {
            if (props.mainAreaAttentionSurfaceId === surface.id) props.onExitMainAreaAttention();
            else
              props.dispatch({
                type: 'close-surface',
                surfaceId: surface.id,
                entitlement: { kind: 'user', reason: 'close-button' },
              });
            onDone?.();
          }}
        >
          ×
        </button>
      </AppTooltip>
    </div>
  );
}
