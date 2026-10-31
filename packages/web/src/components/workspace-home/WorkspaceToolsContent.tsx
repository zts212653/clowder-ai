'use client';

import { DEFAULT_SETTINGS_ENTRY_ID, findEntry, type SettingsEntry } from '@/components/settings/settings-ia';
import { openMailbox } from '@/components/shell/mailbox/mailbox-navigation';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import type { WorkspaceDevSurface, WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { HomeTools } from './HomeTools';
import { HOME_TRANSITIONAL_DESTINATIONS } from './home-rows';
import { useChangedFileCount } from './use-changed-file-count';
import { useHomeDestinationSelect } from './use-home-destination';
import { workspaceToolsCopy } from './workspace-tools.shell-copy';
import './workspace-home-tools.css';
import './workspace-v3.css';

export interface WorkspaceToolsContentProps {
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  workspaceSearch?: LauncherWorkspaceSearch;
  onClose: () => void;
  /** The original host captures reading origin and navigates through the existing Settings IA. */
  onOpenSettings: (entry: SettingsEntry) => void;
  /** The host restores the exact descriptor through its original working-set action. */
  onSelectRecentSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  /** Recent order belongs to the existing working-set owner; tab order is not recent order. */
  recentSurfaces: readonly WorkspaceSurfaceDescriptor[];
  repository?: { name: string; branch: string };
  changedFileCount?: number | null;
  worktreeId?: string | null;
  initialSearchQuery?: string;
}

/** Contents of C's disposable + menu; all entries go through the existing catalog/host. */
export function WorkspaceToolsContent(props: WorkspaceToolsContentProps) {
  const t = useShellCopy(workspaceToolsCopy);
  const select = useHomeDestinationSelect(props);
  const changedFileCount = useChangedFileCount(props.worktreeId ?? null);
  const choose = (destination: WorkspaceLauncherDestination) => {
    select(destination);
    props.onClose();
  };
  // Preserve the owner-provided order and full identity. No inferred tab order or duplicate history store.
  const seen = new Set<string>();
  const recent = props.recentSurfaces
    .filter((surface) => {
      if (seen.has(surface.id)) return false;
      seen.add(surface.id);
      return true;
    })
    .slice(0, 3);
  const workspaceSearch = props.workspaceSearch && {
    ...props.workspaceSearch,
    onOpenResult: (...args: Parameters<LauncherWorkspaceSearch['onOpenResult']>) => {
      props.workspaceSearch?.onOpenResult(...args);
      props.onClose();
    },
    onViewAll: (query: string) => {
      props.workspaceSearch?.onViewAll(query);
      props.onClose();
    },
  };
  return (
    <div className="workspace-tools-content" data-testid="workspace-tools-content">
      <HomeTools
        repository={props.repository}
        changedFileCount={props.changedFileCount === undefined ? changedFileCount : props.changedFileCount}
        initialSearchQuery={props.initialSearchQuery}
        workspaceSearch={workspaceSearch}
        onSelectDestination={choose}
        footer={
          <nav className="home-signpost workspace-tools-signpost text-xs" aria-label={t.otherEntries}>
            {t.beforeTodo}
            <button
              type="button"
              className="shell-focusable"
              data-workspace-destination="mode:product-schedule"
              aria-label={t.openCalendar}
              onClick={() => choose({ ...HOME_TRANSITIONAL_DESTINATIONS.allWork, label: t.calendar })}
            >
              {t.calendar}
            </button>
            {t.inTodo}
            <button
              type="button"
              className="shell-focusable"
              onClick={() => {
                openMailbox({ section: 'pending' });
                props.onClose();
              }}
            >
              {t.todo}
            </button>
            {t.afterTodo}
            <button
              type="button"
              className="shell-focusable"
              onClick={() => choose({ ...canonicalLauncherDestination('mode', 'tasks'), label: t.tasks })}
            >
              {t.tasks}
            </button>
            {t.and}
            <button
              type="button"
              className="shell-focusable"
              onClick={() => choose({ ...canonicalLauncherDestination('mode', 'artifacts'), label: t.works })}
            >
              {t.works}
            </button>
            {t.inHeader}
            {t.beforeSettings}
            <span className="whitespace-nowrap">
              <button
                type="button"
                className="shell-focusable"
                onClick={() => {
                  const entry = findEntry(DEFAULT_SETTINGS_ENTRY_ID);
                  if (entry) {
                    props.onOpenSettings(entry);
                    props.onClose();
                  }
                }}
              >
                {t.settings}
              </button>
              {t.end}
            </span>
          </nav>
        }
        recent={
          recent.length > 0 && (
            <section className="home-group" aria-label={t.recent}>
              <h3 className="home-group-title text-xs">{t.recent}</h3>
              {recent.map((surface) => (
                <button
                  key={surface.id}
                  type="button"
                  className="home-tool shell-focusable text-compact"
                  data-testid="workspace-tool-recent"
                  onClick={() => {
                    props.onSelectRecentSurface(surface);
                    props.onClose();
                  }}
                  title={surface.context}
                >
                  <span className="min-w-0 truncate">{surface.title}</span>
                </button>
              ))}
            </section>
          )
        }
      />
    </div>
  );
}
