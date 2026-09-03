import type { ReactNode } from 'react';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';

function SurfaceGlyph({ type }: { type: WorkspaceSurfaceDescriptor['type'] }) {
  if (type === 'browser') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M2 5.5h12M4 4h.01M6 4h.01" />
      </svg>
    );
  }
  if (type === 'review' || type === 'artifact') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M3 2.5h7l3 3V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
        <path d="M10 2.5V6h3M4.5 9l1.5 1.5L9.5 7" />
      </svg>
    );
  }
  if (type === 'agent-run') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3 1.5h6l4 4V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5Z" />
      <path d="M9 1.5v4h4M5 8h6M5 10.5h6" />
    </svg>
  );
}

export function F307SurfacePane({
  surface,
  visible = true,
  children,
}: {
  surface: WorkspaceSurfaceDescriptor;
  visible?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={`${visible ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-[var(--console-panel-bg)]`}
      data-surface-id={surface.id}
      data-surface-mounted="true"
      aria-label={surface.title}
      aria-hidden={!visible}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-cafe-subtle bg-cafe-surface/70 px-3">
        <span className="h-4 w-4 shrink-0 text-cafe-muted">
          <SurfaceGlyph type={surface.type} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cafe">{surface.title}</span>
        <span className="truncate text-micro text-cafe-muted">{surface.context}</span>
      </header>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto [&>*]:min-h-0 [&>*]:w-full [&>*]:flex-1"
        data-testid="f307-owner-surface-host"
      >
        {children}
      </div>
    </article>
  );
}
