'use client';

import type { EvolutionUseSourceV1 } from '@cat-cafe/shared';
import type { MouseEvent } from 'react';
import { type EvolutionReadingTarget, evolutionReadingHref, openEvolutionTarget } from './evolution-navigation';

function openInWorkspace(event: MouseEvent<HTMLAnchorElement>, target: EvolutionReadingTarget): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openEvolutionTarget(target);
}

export function EvolutionUseSourceDock({ source }: { source: EvolutionUseSourceV1 }) {
  const sourceTarget: EvolutionReadingTarget = {
    programId: source.programId,
    view: 'history',
    versionRef: source.assetVersionRef,
  };
  const rollbackTarget: EvolutionReadingTarget = {
    programId: source.programId,
    view: 'judgment',
    versionRef: source.assetVersionRef,
  };
  const href = typeof window === 'undefined' ? '#' : evolutionReadingHref(sourceTarget, window.location.href);
  const applied = source.use === 'applied';

  return (
    <div
      data-testid="evolution-use-source"
      data-use-status={source.use}
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-cafe-subtle pt-2 text-xs text-cafe-muted"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 flex-none rounded-full ${applied ? 'bg-[var(--semantic-success)]' : 'bg-[var(--semantic-warning)]'}`}
      />
      <span className="text-cafe-secondary">{applied ? '已沿用上次确认的规则' : '沿用情况待确认'}</span>
      <span aria-hidden="true">·</span>
      <a
        data-testid="evolution-use-source-open"
        href={href}
        className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
        onClick={(event) => openInWorkspace(event, sourceTarget)}
      >
        查看来源
      </a>
      <button
        data-testid="evolution-use-source-rollback"
        type="button"
        className="rounded-sm font-medium text-cafe-secondary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
        onClick={() => openEvolutionTarget(rollbackTarget)}
      >
        回退…
      </button>
    </div>
  );
}
