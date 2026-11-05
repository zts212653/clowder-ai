'use client';
import type { DeploymentWaitItemProjection } from '@cat-cafe/shared';
import { useId } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useLiveProjectFolds } from '@/hooks/useLiveProjectFolds';
import { formatWaitDuration } from './format';
import { HomeGroupAvatars, HomeGroupChevron, HomeProjectGroup } from './HomeProjectGroup';
import { HomeWaitRow } from './HomeWaitRow';
import { groupHomeProjects } from './project-groups';
import { homeCopy } from './workspace-home.shell-copy';

type HomeFolds = ReturnType<typeof useLiveProjectFolds>;
function DeploymentRows({
  items,
  path,
  now,
  folds,
  project,
}: {
  items: readonly DeploymentWaitItemProjection[];
  path: string;
  now: number;
  folds: HomeFolds;
  project?: { name: string; current: boolean };
}) {
  const t = useShellCopy(homeCopy);
  const id = useId();
  const collapsed = folds.collapsed[path] ?? true;
  const longest = items.some((item) => item.createdAt === null)
    ? t.wait.waitUnknown
    : t.wait.longest(
        formatWaitDuration(Math.max(...items.map((item) => Math.max(0, now - (item.createdAt ?? now)))), t.time),
      );
  const rows = items.map((item) => <HomeWaitRow key={item.taskId} item={item} now={now} />);
  const error = folds.error && (
    <p className="home-project-unavailable text-xs" role="status">
      {t.live.foldFailed}
    </p>
  );
  if (project) {
    return (
      <HomeProjectGroup
        path={path}
        label={project.name}
        current={project.current}
        collapsed={collapsed}
        busy={folds.loading || folds.saving}
        status={collapsed ? `${t.wait.updateCount(items.length)} · ${longest}` : t.wait.projectCount(items.length)}
        ariaLabel={`${t.wait.projectLabel(project.name, items.length, collapsed)}, ${t.wait.updateShort}, ${longest}`}
        cats={items.flatMap((item) => (item.ownerCatId ? [item.ownerCatId] : []))}
        tone="wait"
        toggle={() => void folds.toggle(path)}
        notice={error}
      >
        {rows}
      </HomeProjectGroup>
    );
  }
  return (
    <div className="home-deployment-group">
      <button
        type="button"
        data-testid="home-deployment-fold"
        className="home-deployment-fold shell-focusable text-xs"
        aria-expanded={!collapsed}
        aria-controls={id}
        disabled={folds.loading || folds.saving}
        onClick={() => void folds.toggle(path)}
      >
        <HomeGroupChevron collapsed={collapsed} />
        <HomeGroupAvatars cats={items.flatMap((item) => (item.ownerCatId ? [item.ownerCatId] : []))} />
        <span className="home-deployment-count">{t.wait.updateCount(items.length)}</span>
        <span className="home-deployment-longest">{longest}</span>
      </button>
      <div id={id} hidden={collapsed}>
        {rows}
      </div>
      {error}
    </div>
  );
}

function WaitingRows({
  items,
  path,
  now,
  folds,
}: {
  items: readonly DeploymentWaitItemProjection[];
  path: string;
  now: number;
  folds: HomeFolds;
}) {
  const updating = items.filter((item) => item.state === 'waiting_for_update');
  return (
    <>
      {items
        .filter((item) => item.state !== 'waiting_for_update')
        .map((item) => (
          <HomeWaitRow key={item.taskId} item={item} now={now} />
        ))}
      {updating.length > 0 && <DeploymentRows items={updating} path={path} now={now} folds={folds} />}
    </>
  );
}

export function HomeWaitGroups({
  items,
  currentProject,
  now,
}: {
  items: readonly DeploymentWaitItemProjection[];
  currentProject: string | null;
  now: number;
}) {
  const t = useShellCopy(homeCopy);
  const folds = useLiveProjectFolds('waiting');
  const deployments = useLiveProjectFolds('deployment');
  const stateOrder = { ready_to_return: 0, unknown: 1, waiting_for_update: 2 };
  const ordered = [...items].sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);
  const groups = groupHomeProjects(
    ordered,
    currentProject,
    (item) => item.projectPath ?? currentProject ?? 'default',
    (item) => item.createdAt ?? Infinity,
  );
  const showProjects = groups.length > 1 || groups.some((group) => group.path !== currentProject);
  return (
    <div className="home-rows">
      {groups.map((group) => {
        const name = group.path === 'default' ? t.live.uncategorized : group.label;
        if (showProjects && group.items.every((item) => item.state === 'waiting_for_update')) {
          return (
            <DeploymentRows
              key={group.path}
              items={group.items}
              path={group.path}
              now={now}
              folds={deployments}
              project={{ name, current: group.path === currentProject }}
            />
          );
        }
        const rows = <WaitingRows items={group.items} path={group.path} now={now} folds={deployments} />;
        if (!showProjects) return <div key={group.path}>{rows}</div>;
        const collapsed = folds.collapsed[group.path] ?? false;
        return (
          <HomeProjectGroup
            key={group.path}
            path={group.path}
            label={name}
            current={group.path === currentProject}
            collapsed={collapsed}
            busy={folds.loading || folds.saving}
            status={t.wait.projectCount(group.items.length)}
            ariaLabel={t.wait.projectLabel(name, group.items.length, collapsed)}
            cats={group.items.flatMap((item) => (item.ownerCatId ? [item.ownerCatId] : []))}
            tone="wait"
            toggle={() => void folds.toggle(group.path)}
          >
            {rows}
          </HomeProjectGroup>
        );
      })}
      {folds.error && (
        <p className="home-project-unavailable text-xs" role="status">
          {t.live.foldFailed}
        </p>
      )}
    </div>
  );
}
