import type { ReactNode } from 'react';
import type { WorkbenchAction, WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { F307SurfacePane } from './F307SurfacePane';

export function F307WorkbenchSidecar({
  surface,
  dispatch,
  renderSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  dispatch: (action: WorkbenchAction) => void;
  renderSurface: (surface: WorkspaceSurfaceDescriptor) => ReactNode;
}) {
  return (
    <aside
      className="flex min-h-0 w-full shrink-0 flex-col border-t border-cafe-subtle bg-cafe-surface md:w-72 md:border-l md:border-t-0"
      data-testid="f307-sidecar"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-cafe-subtle px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cafe">{surface.title}</span>
        <button
          type="button"
          onClick={() =>
            dispatch({
              type: 'promote-sidecar',
              destination: 'tab',
              entitlement: { kind: 'user', reason: 'sidecar-action' },
            })
          }
          className="rounded-md px-2 py-1 text-micro font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
          data-testid="f307-promote-sidecar-tab"
        >
          转为标签
        </button>
        <button
          type="button"
          onClick={() =>
            dispatch({
              type: 'promote-sidecar',
              destination: 'split',
              entitlement: { kind: 'user', reason: 'explicit-split' },
            })
          }
          className="rounded-md px-2 py-1 text-micro font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
          data-testid="f307-promote-sidecar-split"
        >
          并排
        </button>
        <button
          type="button"
          onClick={() =>
            dispatch({
              type: 'close-sidecar',
              entitlement: { kind: 'user', reason: 'close-button' },
            })
          }
          className="rounded-md px-2 py-1 text-micro font-semibold text-cafe-muted hover:bg-cafe-surface-sunken"
          aria-label={`关闭边栏 ${surface.title}`}
        >
          ×
        </button>
      </div>
      <F307SurfacePane surface={surface}>{renderSurface(surface)}</F307SurfacePane>
    </aside>
  );
}
