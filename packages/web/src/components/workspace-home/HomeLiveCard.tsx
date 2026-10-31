'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { useLiveProjectFolds } from '@/hooks/useLiveProjectFolds';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { clearExecutionDetailRequest, useExecutionDetailRequest } from './execution-detail-request';
import { HomeExecutionRow } from './HomeExecutionRow';
import { HomeLiveProject } from './HomeLiveProject';
import { groupLiveProjects } from './live-project-groups';
import './home-live-projects.css';
import { ManagedExecutionDetail } from './ManagedExecutionDetail';
import { useHomeClock } from './use-home-clock';
import { homeCopy } from './workspace-home.shell-copy';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

function HomeLiveContent({
  threadId,
  onSelectExecution,
}: {
  threadId?: string;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}) {
  const t = useShellCopy(homeCopy);
  const v3 = useShellCopy(workspaceV3Copy);
  const { getCatById } = useCatData();
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const hydration = useActiveExecutionStore((state) => state.hydration);
  const currentProject = useActiveExecutionStore((state) => state.projectPath);
  const unavailable = useActiveExecutionStore((state) => state.unavailableProjectPaths);
  const folds = useLiveProjectFolds();
  const projects = useMemo(
    () => groupLiveProjects(Object.values(executionsByKey), currentProject, unavailable),
    [executionsByKey, currentProject, unavailable],
  );
  const running = projects.flatMap((project) => project.executions);
  const request = useExecutionDetailRequest();
  const requestedKey = request && request.hostThreadId === threadId ? request.executionKey : null;
  const hasRequestedRow = requestedKey !== null && running.some((item) => activeExecutionKey(item) === requestedKey);
  const showProjects = projects.length > 1 || (projects.length === 1 && projects[0].path !== currentProject);
  const nicknameOwners = new Map<string, Set<string>>();
  for (const catId of new Set(running.map((execution) => execution.catId))) {
    const cat = getCatById(catId);
    const nickname = cat?.nickname?.trim() || cat?.displayName || catId;
    const owners = nicknameOwners.get(nickname) ?? new Set<string>();
    owners.add(catId);
    nicknameOwners.set(nickname, owners);
  }
  const rowName = (catId: string) => {
    const cat = getCatById(catId);
    const nickname = cat?.nickname?.trim() || cat?.displayName || catId;
    return (nicknameOwners.get(nickname)?.size ?? 0) > 1 ? resolveCatNameplateName(catId, getCatById) : nickname;
  };
  const ticking = running.length > 0;
  const now = useHomeClock(ticking, 1000);

  return (
    <section className="home-section" data-testid="workspace-developing" aria-labelledby="home-live-title">
      <header className="home-card-head">
        <span className="home-dot" data-tone="live" aria-hidden="true" />
        <h2 id="home-live-title" className="home-card-title text-sm">
          {t.live.title}
        </h2>
        <span className="home-card-scope text-xs">
          {unavailable.length ? t.live.partialScope(running.length) : t.live.scope(running.length)}
        </span>
      </header>
      {running.length === 0 && unavailable.length === 0 && (
        <output data-testid="workspace-developing-status" className="text-xs text-cafe-muted">
          {hydration === 'loading' ? t.live.loading : hydration === 'error' ? t.live.unverified : v3.empty}
        </output>
      )}
      <div className="home-rows">
        {projects.map((project) => {
          const rows = project.executions.map((execution) => (
            <HomeExecutionRow
              key={activeExecutionKey(execution)}
              execution={execution}
              threadTitle={execution.threadTitle ?? execution.threadId}
              catName={rowName(execution.catId)}
              here={threadId !== undefined && execution.threadId === threadId}
              now={now}
              onSelectExecution={onSelectExecution}
              detail={
                activeExecutionKey(execution) === requestedKey ? (
                  <ManagedExecutionDetail threadId={threadId} />
                ) : undefined
              }
              detailRevision={activeExecutionKey(execution) === requestedKey ? request?.revision : undefined}
            />
          ));
          return showProjects || project.unavailable ? (
            <HomeLiveProject
              key={project.path}
              group={project}
              current={project.path === currentProject}
              collapsed={
                folds.collapsed[project.path] === true &&
                !project.executions.some((item) => activeExecutionKey(item) === requestedKey)
              }
              busy={folds.loading || folds.saving}
              toggle={() => {
                const revealed = project.executions.some((item) => activeExecutionKey(item) === requestedKey);
                if (revealed) clearExecutionDetailRequest();
                if (!revealed || folds.collapsed[project.path] !== true) void folds.toggle(project.path);
              }}
              now={now}
            >
              {rows}
            </HomeLiveProject>
          ) : (
            rows
          );
        })}
      </div>
      {requestedKey && !hasRequestedRow ? <ManagedExecutionDetail threadId={threadId} /> : null}
      {folds.error && showProjects && (
        <p className="home-card-foot text-xs" data-tone="warn" role="status">
          {t.live.foldFailed}
        </p>
      )}
      {hydration === 'error' && (
        <p className="home-card-foot text-xs" data-tone="warn">
          {t.live.stale}
        </p>
      )}
    </section>
  );
}

export function HomeLiveCard(props: Parameters<typeof HomeLiveContent>[0]) {
  return <HomeLiveContent {...props} />;
}
