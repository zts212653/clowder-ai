'use client';
import type { ReactNode } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { formatElapsed } from './format';
import { HomeProjectGroup } from './HomeProjectGroup';
import type { LiveProjectGroup } from './live-project-groups';
import { homeCopy } from './workspace-home.shell-copy';

export function HomeLiveProject({
  group,
  current,
  collapsed,
  busy,
  now,
  toggle,
  children,
}: {
  group: LiveProjectGroup;
  current: boolean;
  collapsed: boolean;
  busy: boolean;
  now: number;
  toggle(): void;
  children: ReactNode;
}) {
  const t = useShellCopy(homeCopy).live;
  const name = group.path === 'default' ? t.uncategorized : group.label;
  const count = group.executions.length;
  const waiting = group.waits.length;
  const running = group.unavailable
    ? t.confirmedCount(count)
    : collapsed && count > 0
      ? t.projectRunning(count, formatElapsed(now - group.executions[0].startedAt))
      : t.projectCount(count);
  // A project that only waits says so instead of "0 件".
  const status =
    count === 0 && waiting > 0 && !group.unavailable
      ? t.projectWaiting(waiting)
      : `${running}${waiting > 0 ? t.waitingTail(waiting) : ''}`;
  return (
    <HomeProjectGroup
      path={group.path}
      label={name}
      current={current}
      collapsed={collapsed}
      busy={busy}
      status={status}
      ariaLabel={group.unavailable ? `${name}: ${t.projectUnavailable}` : t.projectLabel(name, count, collapsed)}
      cats={[...group.executions, ...group.waits].map((item) => item.catId)}
      toggle={toggle}
      notice={
        group.unavailable && (
          <p className="home-project-unavailable text-xs" role="status">
            {t.projectUnavailable}
          </p>
        )
      }
    >
      {children}
    </HomeProjectGroup>
  );
}
