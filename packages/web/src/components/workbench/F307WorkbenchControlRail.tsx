'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkbenchAction, WorkbenchLayoutState } from './workbench-contract';

function SplitIcon({ collapse = false }: { collapse?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M8 2.75v10.5" />
      {collapse && <path d="m5.75 6 2 2-2 2m4.5-4-2 2 2 2" />}
    </svg>
  );
}

function ManageIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="13" cy="8" r="1.25" />
    </svg>
  );
}

export function F307WorkbenchControlRail({
  layout,
  dispatch,
  onAddSurface,
  homeFocused,
}: {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  onAddSurface: () => void;
  homeFocused: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const activeSurface = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId) ?? null;
  const splitCandidate = layout.surfaces.find((surface) => surface.id !== layout.activeSurfaceId) ?? null;
  const closeableCount = activeSurface
    ? layout.surfaces.filter(
        (surface) => surface.id !== activeSurface.id && !layout.pinnedSurfaceIds.includes(surface.id),
      ).length
    : 0;

  useEffect(() => {
    if (!menuOpen) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [menuOpen]);

  return (
    <div
      ref={menuRoot}
      className="relative z-20 flex shrink-0 items-center border-l border-cafe-subtle bg-cafe-surface px-1"
      data-testid="f307-control-rail"
    >
      <button
        type="button"
        onClick={onAddSurface}
        className={`flex h-8 w-8 items-center justify-center rounded-lg text-lg leading-none transition-colors ${
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

      {layout.surfaces.length > 1 && (
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe"
          aria-label="管理工作台页面"
          aria-expanded={menuOpen}
          title="管理工作台页面"
          data-testid="f307-manage-surfaces"
        >
          <span className="h-4 w-4">
            <ManageIcon />
          </span>
        </button>
      )}

      {layout.split === null && activeSurface !== null && splitCandidate !== null && (
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
      )}

      {layout.split !== null && (
        <button
          type="button"
          onClick={() => dispatch({ type: 'collapse-split', entitlement: { kind: 'user', reason: 'collapse-split' } })}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe"
          aria-label="退出分屏"
          title="退出分屏（页面仍保留）"
          data-testid="f307-exit-split"
        >
          <span className="h-4 w-4">
            <SplitIcon collapse />
          </span>
        </button>
      )}

      {menuOpen && activeSurface !== null && (
        <div
          className="absolute right-1 top-[calc(100%+0.25rem)] z-30 w-52 rounded-xl border border-cafe-subtle bg-cafe-surface p-1.5 shadow-lg"
          role="menu"
          data-testid="f307-surface-menu"
        >
          <button
            type="button"
            onClick={() => {
              dispatch({
                type: 'close-other-surfaces',
                preserveSurfaceId: activeSurface.id,
                entitlement: { kind: 'user', reason: 'bulk-close' },
              });
              setMenuOpen(false);
            }}
            disabled={closeableCount === 0}
            className="w-full rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken disabled:cursor-not-allowed disabled:opacity-45"
            role="menuitem"
            data-testid="f307-close-other-surfaces"
          >
            收起其他未固定页面
            <span className="mt-0.5 block text-micro font-normal text-cafe-muted">保留当前页与固定页</span>
          </button>
        </div>
      )}
    </div>
  );
}
