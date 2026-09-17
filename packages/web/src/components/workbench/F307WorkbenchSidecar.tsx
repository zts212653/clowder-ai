import { type ReactNode, useId, useState } from 'react';
import type { WorkbenchAction, WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { F307SurfacePane } from './F307SurfacePane';

export function F307WorkbenchSidecar({
  surface,
  dispatch,
  renderSurface,
  visible = true,
}: {
  surface: WorkspaceSurfaceDescriptor;
  dispatch: (action: WorkbenchAction) => void;
  renderSurface: (surface: WorkspaceSurfaceDescriptor, visible: boolean) => ReactNode;
  visible?: boolean;
}) {
  const isDesktop = useIsDesktop();
  const [expandedOnNarrow, setExpandedOnNarrow] = useState(false);
  const bodyId = useId();
  const bodyVisible = visible && (isDesktop || expandedOnNarrow);
  return (
    <aside
      className={`${visible ? 'flex' : 'hidden'} max-h-[45%] min-h-0 w-full shrink-0 flex-col border-t border-cafe-subtle bg-cafe-surface md:max-h-none md:w-72 md:border-l md:border-t-0`}
      data-testid="f307-sidecar"
      aria-hidden={!visible}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-cafe-subtle px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-cafe md:hidden"
          aria-expanded={expandedOnNarrow}
          aria-controls={bodyId}
          data-testid="f307-sidecar-expand"
          onClick={() => setExpandedOnNarrow((current) => !current)}
        >
          <span className="truncate">{surface.title}</span>
          <span className="text-micro font-normal text-cafe-muted">{expandedOnNarrow ? '收起' : '展开'}</span>
        </button>
        <span className="hidden min-w-0 flex-1 truncate text-xs font-semibold text-cafe md:block">{surface.title}</span>
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
      <div id={bodyId} className={`${expandedOnNarrow ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col md:flex`}>
        <F307SurfacePane surface={surface} visible={bodyVisible}>
          {renderSurface(surface, bodyVisible)}
        </F307SurfacePane>
      </div>
    </aside>
  );
}
