'use client';

import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { DeploymentWaitHydration } from '@/components/workspace/WorkspaceDeploymentWaits';
import { useDeploymentWaitProjection } from '@/hooks/useDeploymentWaitProjection';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { formatObservedAge, shortRevision } from './format';
import { HomeWaitGroups } from './HomeWaitGroups';
import { useHomeClock } from './use-home-clock';
import { homeCopy } from './workspace-home.shell-copy';

/**
 * 等待与接回 on the new shell's Workspace home — presentation only.
 *
 * Owned by F323: the same `/api/runtime-deployment/waits` projection, hydration states and 重试 as the classic card, the
 * same three item states. A short neutral summary stays visible; the original condition and next step remain in a closed
 * disclosure. The candidate count is a forecast after deployment, never a claim that a waiting item is already ready.
 */

function CandidateLine({ projection, now }: { projection: DeploymentWaitListResponse; now: number }) {
  const t = useShellCopy(homeCopy);
  const candidate = projection.candidate;
  if (!candidate) return null;
  return (
    <p
      className="home-card-foot text-xs"
      data-testid="deployment-candidate-preview"
      title={`${t.wait.candidate(shortRevision(candidate.revision))} · ${t.wait.observed(formatObservedAge(candidate.observedAt, now, t.time))} · ${t.wait.satisfiable(candidate.satisfiableCount)}`}
    >
      {t.wait.resumeForecast(candidate.satisfiableCount)}
      {candidate.unknownCount > 0 && <span> · {t.wait.unknownEvidence(candidate.unknownCount)}</span>}
    </p>
  );
}

function WaitCardView({
  projection,
  hydration,
  onRetry,
}: {
  projection: DeploymentWaitListResponse | null;
  hydration: DeploymentWaitHydration;
  onRetry: () => void;
}) {
  const t = useShellCopy(homeCopy);
  const currentProject = useActiveExecutionStore((state) => state.projectPath);
  const now = useHomeClock(projection !== null && projection.items.length > 0, 30_000);
  if (hydration === 'idle') return null;
  if (!projection && hydration === 'loading') {
    return (
      <section className="home-section home-note text-xs" data-testid="workspace-deployment-waits">
        {t.wait.loading}
      </section>
    );
  }
  if (!projection) {
    return (
      <section className="home-section home-note text-xs" data-tone="warn" data-testid="workspace-deployment-waits">
        <span>{t.wait.error}</span>
        <button
          type="button"
          className="home-link shell-focusable text-xs"
          onClick={onRetry}
          data-testid="deployment-waits-retry"
        >
          {t.wait.retry}
        </button>
      </section>
    );
  }

  const items = projection.items;
  return (
    <section className="home-section" data-testid="workspace-deployment-waits" aria-labelledby="home-wait-title">
      <div data-testid="home-wait-card-body">
        <header className="home-card-head">
          <span className="home-dot" data-tone="wait" aria-hidden="true" />
          <h2 id="home-wait-title" className="home-card-title text-sm">
            {t.wait.title}
          </h2>
          {items.length > 0 && <span className="home-card-scope text-xs">{t.wait.scope(items.length)}</span>}
        </header>
        {items.length === 0 ? (
          <div className="home-empty">
            <p className="home-empty-title text-compact">{t.wait.empty}</p>
            <p className="home-empty-hint text-xs">{t.wait.emptyHint}</p>
          </div>
        ) : (
          <HomeWaitGroups items={items} currentProject={currentProject ?? projection.projectPath} now={now} />
        )}
        <CandidateLine projection={projection} now={now} />
        {hydration === 'error' && (
          <p className="home-card-foot text-xs" data-tone="warn">
            <span>{t.wait.stale}</span>{' '}
            <button
              type="button"
              className="home-link shell-focusable text-xs"
              onClick={onRetry}
              data-testid="deployment-waits-retry"
            >
              {t.wait.retry}
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

export function HomeWaitCard({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean } = {}) {
  const projectPath = useActiveExecutionStore((state) => state.projectPath);
  const deploymentWaits = useDeploymentWaitProjection(projectPath, 'all');
  if (hideWhenEmpty && deploymentWaits.hydration !== 'error' && deploymentWaits.projection?.items.length === 0)
    return null;
  return (
    <WaitCardView
      projection={deploymentWaits.projection}
      hydration={deploymentWaits.hydration}
      onRetry={() => void deploymentWaits.retry()}
    />
  );
}
