'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { ChatVoiceFeatureControls } from '@/components/ChatVoiceFeatureControls';
import { openTheaterReplay } from '@/components/ThreadSidebar/theater-navigation';
import { WORKSPACE_MODE_META, type WorkspaceMode } from '@/lib/workspace-modes';
import type { WorkspaceSurface } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { RecentTrajectoryRecall } from './RecentTrajectoryRecall';
import { WorkspaceLauncherMark } from './WorkspaceLauncherMark';
import { type LauncherWorkspaceSearch, WorkspaceLauncherSearch } from './WorkspaceLauncherSearch';

export type WorkspaceDevSurface = WorkspaceSurface;

export type WorkspaceLauncherDestination =
  | {
      kind: 'surface';
      id: Exclude<WorkspaceDevSurface, 'home'>;
      label: string;
      description: string;
      searchTerms: string;
    }
  | {
      kind: 'mode';
      id: Exclude<WorkspaceMode, 'dev'>;
      label: string;
      description: string;
      searchTerms: string;
    }
  | {
      kind: 'host';
      id: 'status';
      label: string;
      description: string;
      searchTerms: string;
    }
  | {
      kind: 'workspace';
      id: 'capability-evolution';
      label: string;
      description: string;
      searchTerms: string;
    }
  | {
      kind: 'action';
      id: 'theater';
      label: string;
      description: string;
      searchTerms: string;
    };

const WORK_DESTINATIONS: WorkspaceLauncherDestination[] = [
  {
    kind: 'surface',
    id: 'files',
    label: '文件与代码',
    description: '浏览与打开工作区文件',
    searchTerms: 'files tree source 文件 目录 代码 搜索',
  },
  {
    kind: 'surface',
    id: 'changes',
    label: '变更',
    description: '看看这次改了什么',
    searchTerms: 'changes diff 变更 差异',
  },
  {
    kind: 'surface',
    id: 'git',
    label: 'Git',
    description: '分支、提交与仓库状态',
    searchTerms: 'git branch commit 分支 提交',
  },
  {
    kind: 'surface',
    id: 'terminal',
    label: '终端',
    description: '回到当前 worktree 会话',
    searchTerms: 'terminal shell cli 终端 命令行',
  },
  {
    kind: 'workspace',
    id: 'capability-evolution',
    label: '能力进化',
    description: '让猫猫与系统持续变得更好',
    searchTerms: 'capability evolution program 能力 进化 成长',
  },
  {
    kind: 'surface',
    id: 'browser',
    label: '页面预览',
    description: '打开当前 worktree 的 Browser',
    searchTerms: 'browser preview chrome 浏览器 页面 预览',
  },
];

const THREAD_DESTINATIONS: WorkspaceLauncherDestination[] = [
  {
    kind: 'host',
    id: 'status',
    label: '状态与会话',
    description: '查看 Session、Thread ID 与运行详情',
    searchTerms: 'status activity session thread id diagnostics 状态 状态栏 当前动态 会话 诊断',
  },
  {
    kind: 'action',
    id: 'theater',
    label: '猫猫大剧院 / 回放',
    description: '用现有 Theater Overlay 回看这段对话',
    searchTerms: 'theater story replay 回放 大剧院 剧场',
  },
];

const MODE_GROUPS: Array<{ label: string; destinations: Array<Exclude<WorkspaceMode, 'dev'>> }> = [
  { label: '组织工作', destinations: ['team', 'needs-me', 'product-schedule', 'tasks', 'schedule', 'approval'] },
  { label: '回看与理解', destinations: ['recall', 'trajectory', 'artifacts', 'community', 'eval'] },
];

function modeDestination(mode: Exclude<WorkspaceMode, 'dev'>): WorkspaceLauncherDestination {
  const meta = WORKSPACE_MODE_META[mode];
  return {
    kind: 'mode',
    id: mode,
    label: meta.label,
    description: meta.description,
    searchTerms: meta.searchTerms,
  };
}

function DestinationCard({
  destination,
  onSelect,
}: {
  destination: WorkspaceLauncherDestination;
  onSelect: () => void;
}) {
  const testId =
    destination.kind === 'surface'
      ? `workspace-launcher-dev-${destination.id}`
      : `workspace-launcher-${destination.id}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className="group flex min-h-20 w-full items-center gap-3 rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] px-3.5 py-3 text-left text-cafe-black transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-cafe-accent/35 hover:bg-cafe-surface"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cafe-accent/10 text-cafe-accent">
        <WorkspaceLauncherMark mode={destination.kind === 'surface' ? 'dev' : destination.id} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tracking-tight">{destination.label}</span>
        <span className="mt-0.5 block text-micro leading-4 text-cafe-secondary">{destination.description}</span>
      </span>
      <svg
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-cafe-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cafe-accent"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 3.5 4.5 4.5L6 12.5" />
      </svg>
    </button>
  );
}

export function WorkspaceLauncher({
  onSelectDevSurface,
  onSelectDestination,
  onOpenStatus,
  threadId,
  defaultCatId = 'opus',
  actions,
  workspaceSearch,
}: {
  onSelectDevSurface?: (surface: WorkspaceDevSurface) => void;
  onSelectDestination?: (destination: WorkspaceLauncherDestination) => void;
  onOpenStatus?: () => void;
  threadId?: string;
  defaultCatId?: string;
  actions?: ReactNode;
  workspaceSearch?: LauncherWorkspaceSearch;
}) {
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  const openTeamSubject = useChatStore((state) => state.openTeamSubject);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visibleGroups = useMemo(() => {
    const groups = [
      { label: '现在要做什么', destinations: WORK_DESTINATIONS },
      { label: '当前对话', destinations: THREAD_DESTINATIONS },
      ...MODE_GROUPS.map((group) => ({
        label: group.label,
        destinations: group.destinations.map(modeDestination),
      })),
    ];
    if (!normalizedQuery) return groups;
    return groups
      .map((group) => ({
        ...group,
        destinations: group.destinations.filter((destination) =>
          `${destination.label} ${destination.description} ${destination.searchTerms}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.destinations.length > 0);
  }, [normalizedQuery]);

  const showCompanions =
    !normalizedQuery ||
    '陪伴 语音陪伴 会议伴随 朗读 录音 转写 voice companion meeting transcript'.includes(normalizedQuery);

  const selectDestination = (destination: WorkspaceLauncherDestination) => {
    if (destination.kind === 'surface') {
      setWorkspaceMode('dev');
      onSelectDevSurface?.(destination.id);
    } else if (destination.kind === 'mode') {
      if (destination.id === 'team') openTeamSubject(null);
      else setWorkspaceMode(destination.id);
    } else if (destination.kind === 'host') {
      onOpenStatus?.();
    } else if (destination.kind === 'action' && threadId) {
      openTheaterReplay(threadId);
    }
    onSelectDestination?.(destination);
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-5" data-testid="workspace-launcher-home">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-micro font-bold uppercase tracking-[0.16em] text-cafe-accent">Workspace</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-cafe-black">你想打开什么？</h2>
        </div>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>

      <WorkspaceLauncherSearch query={query} onQueryChange={setQuery} workspaceSearch={workspaceSearch} />

      <div className="space-y-6">
        {!normalizedQuery && threadId && <RecentTrajectoryRecall threadId={threadId} />}
        {visibleGroups.map((group) => (
          <section key={group.label}>
            <h3 className="mb-2 text-label font-semibold text-cafe-secondary">{group.label}</h3>
            <div
              className="grid gap-2.5"
              data-testid="workspace-launcher-grid"
              data-layout="panel-auto-fit"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))' }}
            >
              {group.destinations.map((destination) => (
                <DestinationCard
                  key={`${destination.kind}:${destination.id}`}
                  destination={destination}
                  onSelect={() => selectDestination(destination)}
                />
              ))}
            </div>
          </section>
        ))}
        {showCompanions && (
          <section>
            <h3 className="mb-2 text-label font-semibold text-cafe-secondary">陪伴</h3>
            <ChatVoiceFeatureControls threadId={threadId} defaultCatId={defaultCatId} />
          </section>
        )}
        {visibleGroups.length === 0 && !showCompanions && (
          <div className="rounded-xl border border-dashed border-cafe-subtle px-4 py-10 text-center text-xs text-cafe-secondary">
            没有找到匹配的内容
          </div>
        )}
      </div>
    </div>
  );
}
