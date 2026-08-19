'use client';

import { useLayoutEffect, useState } from 'react';
import { Rnd } from 'react-rnd';

const CARD_WIDTH = 320;
const CARD_HEIGHT = 116;
const COLLAPSED_HEIGHT = 40;
const VIEWPORT_MARGIN = 16;
const BOTTOM_OFFSET = 112;

interface ProgressCardGeometry {
  width: number;
  x: number;
  y: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

export function clampProgressCardGeometry(
  geometry: ProgressCardGeometry,
  cardHeight: number,
  viewport: ViewportSize,
): ProgressCardGeometry {
  const maxX = Math.max(0, viewport.width - geometry.width);
  const maxY = Math.max(0, viewport.height - cardHeight);
  return {
    ...geometry,
    x: Math.min(maxX, Math.max(0, geometry.x)),
    y: Math.min(maxY, Math.max(0, geometry.y)),
  };
}

function initialGeometry() {
  const width = Math.min(CARD_WIDTH, Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2));
  return {
    width,
    x: Math.max(VIEWPORT_MARGIN, window.innerWidth - width - 24),
    y: Math.max(VIEWPORT_MARGIN, window.innerHeight - CARD_HEIGHT - BOTTOM_OFFSET),
  };
}

interface DesktopUpdateProgressCardProps {
  progress: DesktopUpdateProgressPayload;
  onHide(): void;
}

export function DesktopUpdateProgressCard({ progress, onHide }: DesktopUpdateProgressCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [{ width, ...position }, setGeometry] = useState(initialGeometry);
  const percent = Math.round(Math.min(1, Math.max(0, progress.progress)) * 100);
  const height = collapsed ? COLLAPSED_HEIGHT : CARD_HEIGHT;

  useLayoutEffect(() => {
    const clampToViewport = () => {
      setGeometry((current) => {
        const next = clampProgressCardGeometry(current, height, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    clampToViewport();
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [height]);

  return (
    <Rnd
      data-testid="desktop-update-progress-rnd"
      position={position}
      size={{ width, height }}
      enableResizing={false}
      bounds="window"
      dragHandleClassName="desktop-update-progress-drag-handle"
      cancel=".desktop-update-progress-action"
      style={{ position: 'fixed', zIndex: 40 }}
      onDragStop={(_event, data) => setGeometry((current) => ({ ...current, x: data.x, y: data.y }))}
    >
      <section
        data-testid="desktop-update-progress"
        aria-label="Update download progress"
        className="h-full overflow-hidden rounded-xl border border-cafe bg-cafe-surface-elevated shadow-xl ring-1 ring-[var(--console-border-soft)]"
      >
        <div className="desktop-update-progress-drag-handle flex h-10 cursor-move select-none items-center gap-2 px-3">
          <span
            data-testid="desktop-update-progress-dot"
            className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-cafe-accent"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-cafe-primary">Downloading update</span>
          <span
            data-testid="desktop-update-progress-percent"
            className="font-mono text-xs tabular-nums text-cafe-accent"
          >
            {percent}%
          </span>
          <button
            type="button"
            aria-label={collapsed ? 'Expand download progress' : 'Collapse download progress'}
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((value) => !value)}
            className="desktop-update-progress-action rounded px-1 text-sm text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-primary"
          >
            {collapsed ? '▢' : '–'}
          </button>
          <button
            type="button"
            aria-label="Hide download progress; download continues"
            title="Hide — download continues"
            onClick={onHide}
            className="desktop-update-progress-action rounded px-1 text-sm text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-primary"
          >
            ×
          </button>
        </div>

        {!collapsed && (
          <div data-testid="desktop-update-progress-details" className="border-t border-cafe px-3 pb-3 pt-2">
            <p className="truncate text-xs text-cafe-secondary" title={progress.assetName}>
              {progress.assetName}
            </p>
            <div
              role="progressbar"
              aria-label={`Downloading ${progress.assetName}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="mt-2 h-2 overflow-hidden rounded-full bg-cafe-surface-sunken"
            >
              <div
                data-testid="desktop-update-progress-fill"
                className="h-full rounded-full bg-cafe-accent transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-micro text-cafe-muted">You can keep using Clowder AI while it downloads.</p>
          </div>
        )}
      </section>
    </Rnd>
  );
}
