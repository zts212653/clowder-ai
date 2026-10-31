'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useDeploymentWaitProjection } from '@/hooks/useDeploymentWaitProjection';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { HomeLiveCard } from '../workspace-home/HomeLiveCard';
import { HomeWaitCard } from '../workspace-home/HomeWaitCard';
import { groupHomeProjects } from '../workspace-home/project-groups';
import { homeCopy } from '../workspace-home/workspace-home.shell-copy';
import { WorkspaceDeploymentWaits } from './WorkspaceDeploymentWaits';
import { WorkspaceRunningWork } from './WorkspaceRunningWork';
import { groupRunningWork } from './workspace-running-work';
import '../workspace-home/workspace-home-cards.css';
import '../workspace-home/workspace-v3.css';
import '../workspace-home/home-rows.css';
import '../workspace-home/home-unified.css';

interface WorkspaceNowSurfaceProps {
  repository?: { name: string; branch: string };
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}

function ClassicWorkspaceNowSurface({ repository, onSelectExecution }: WorkspaceNowSurfaceProps) {
  const { getCatById } = useCatData();
  const t = useShellCopy(homeCopy).live;
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const hydration = useActiveExecutionStore((state) => state.hydration);
  const projectPath = useActiveExecutionStore((state) => state.projectPath);
  const running = useMemo(() => groupRunningWork(Object.values(executionsByKey)), [executionsByKey]);
  const unavailable = useActiveExecutionStore((state) => state.unavailableProjectPaths);
  const projects = groupHomeProjects(
    running,
    projectPath,
    (work) => work.executions[0].projectPath ?? projectPath ?? 'default',
    (work) => work.executions[0].startedAt,
    unavailable,
  );
  const showProjects = projects.length > 1 || projects.some((project) => project.path !== projectPath);
  const projectByWork = new Map(
    projects.flatMap((project) =>
      project.items.map(
        (work) =>
          [
            work.key,
            { path: project.path, label: project.path === 'default' ? t.uncategorized : project.label },
          ] as const,
      ),
    ),
  );
  const deploymentWaits = useDeploymentWaitProjection(projectPath);

  const runningSurface =
    running.length === 0 && unavailable.length === 0 ? (
      hydration === 'loading' ? (
        <section className="border-b border-cafe-subtle/55 px-5 py-4 text-xs text-cafe-muted">
          正在同步所有对话的运行状态…
        </section>
      ) : hydration === 'error' ? (
        <section className="border-b border-cafe-subtle/55 px-5 py-4 text-xs text-conn-amber-text">
          当前无法验证运行状态，请稍后重试。
        </section>
      ) : null
    ) : (
      <section className="border-b border-cafe-subtle/55 px-5 py-5" data-testid="workspace-developing">
        <div className="mx-auto max-w-2xl">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-micro font-semibold text-cafe-secondary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--semantic-success)]" />
                正在发生
              </div>
              <h2 className="mt-1.5 text-base font-semibold tracking-tight text-cafe-black">
                {unavailable.length > 0
                  ? t.confirmedCount(running.length)
                  : running.length === 1
                    ? '一件工作正在进行'
                    : `${running.length} 件工作正在进行`}
              </h2>
            </div>
            {repository && (
              <div className="min-w-0 text-right text-micro text-cafe-muted">
                <div className="truncate font-medium text-cafe-secondary">
                  {showProjects && `${t.currentProject} · `}
                  {repository.name}
                </div>
                <div className="max-w-48 truncate font-mono">{repository.branch}</div>
              </div>
            )}
          </div>

          <div className="divide-y divide-cafe-subtle/60 border-y border-cafe-subtle/60">
            {running.map((work) => (
              <WorkspaceRunningWork
                key={work.key}
                work={work}
                project={showProjects ? projectByWork.get(work.key) : undefined}
                catName={resolveCatDisplayName(work.catId, getCatById)}
                onSelectExecution={onSelectExecution}
              />
            ))}
          </div>
          {projects
            .filter((project) => unavailable.includes(project.path))
            .map((project) => (
              <p key={project.path} className="mt-2 text-micro text-conn-amber-text" role="status" title={project.path}>
                {project.path === 'default' ? t.uncategorized : project.label} · {t.projectUnavailable}
              </p>
            ))}
          {hydration === 'error' && (
            <p className="mt-2 text-micro text-conn-amber-text">同步暂时失败，以上为最近一次已验证状态。</p>
          )}
        </div>
      </section>
    );

  return (
    <>
      {runningSurface}
      <WorkspaceDeploymentWaits
        projection={deploymentWaits.projection}
        hydration={deploymentWaits.hydration}
        onRetry={() => void deploymentWaits.retry()}
      />
    </>
  );
}

export function WorkspaceNowSurface(props: WorkspaceNowSurfaceProps) {
  const presentation = useShellPresentation();
  const threadId = useChatStore((state) => state.currentThreadId);
  if (presentation !== 'v2') return <ClassicWorkspaceNowSurface {...props} />;
  return (
    <div className="home-v2 min-h-0 flex-1 overflow-auto" data-testid="workspace-now-v2">
      <div className="home-column">
        <HomeLiveCard threadId={threadId} onSelectExecution={props.onSelectExecution} />
        <HomeWaitCard hideWhenEmpty />
      </div>
    </div>
  );
}
