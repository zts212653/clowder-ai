'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { ChatVoiceFeatureControls } from '@/components/ChatVoiceFeatureControls';
import { openTheaterReplay } from '@/components/ThreadSidebar/theater-navigation';
import { WORKSPACE_MODE_META, type WorkspaceMode } from '@/lib/workspace-modes';
import type { WorkspaceSurface } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { RecentTrajectoryRecall } from './RecentTrajectoryRecall';
import { type LauncherWorkspaceSearch, WorkspaceLauncherSearch } from './WorkspaceLauncherSearch';

export type WorkspaceDevSurface = WorkspaceSurface;

type LauncherDestination =
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
      kind: 'action';
      id: 'theater';
      label: string;
      description: string;
      searchTerms: string;
    };

const WORK_DESTINATIONS: LauncherDestination[] = [
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
    kind: 'surface',
    id: 'browser',
    label: '页面预览',
    description: '打开当前 worktree 的 Browser',
    searchTerms: 'browser preview chrome 浏览器 页面 预览',
  },
];

const THREAD_DESTINATIONS: LauncherDestination[] = [
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
  { label: '组织工作', destinations: ['tasks', 'schedule', 'approval'] },
  { label: '回看与理解', destinations: ['recall', 'trajectory', 'artifacts', 'community', 'eval'] },
];

function modeDestination(mode: Exclude<WorkspaceMode, 'dev'>): LauncherDestination {
  const meta = WORKSPACE_MODE_META[mode];
  return {
    kind: 'mode',
    id: mode,
    label: meta.label,
    description: meta.description,
    searchTerms: meta.searchTerms,
  };
}

function ModeMark({ mode }: { mode: WorkspaceMode | 'status' | 'theater' }) {
  const paths: Record<WorkspaceMode | 'status' | 'theater', ReactNode> = {
    dev: <path d="M8 4 3 8l5 4M12 4l5 4-5 4M11 2 9 14" />,
    recall: <path d="M8 3a3 3 0 0 0-3 3 3 3 0 0 0 0 6 3 3 0 0 0 3-3m0-6a3 3 0 0 1 3 3 3 3 0 0 1 0 6 3 3 0 0 1-3-3" />,
    schedule: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4v4l3 2" />
      </>
    ),
    tasks: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="m5 8 2 2 4-4" />
      </>
    ),
    community: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="11.5" cy="7" r="2" />
        <path d="M2.5 14c.5-3 2-4.5 4-4.5S10 11 10.5 14M10 10c2 0 3 1.5 3.5 4" />
      </>
    ),
    artifacts: (
      <>
        <path d="m8 2 6 3-6 3-6-3 6-3Z" />
        <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
      </>
    ),
    approval: (
      <>
        <path d="M5 2h6l2 2v10H3V2h2" />
        <path d="m5 9 2 2 4-4M5 5h5" />
      </>
    ),
    trajectory: (
      <>
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
      </>
    ),
    eval: (
      <>
        <path d="M3 14V8M8 14V3M13 14v-4" />
        <path d="M2 14h12" />
      </>
    ),
    status: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7v4M8 4.5h.01" />
      </>
    ),
    theater: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="m7 6 4 2-4 2V6Z" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[mode]}
    </svg>
  );
}

function DestinationCard({ destination, onSelect }: { destination: LauncherDestination; onSelect: () => void }) {
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
        <ModeMark mode={destination.kind === 'surface' ? 'dev' : destination.id} />
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
  onOpenStatus,
  threadId,
  defaultCatId = 'opus',
  actions,
  workspaceSearch,
}: {
  onSelectDevSurface?: (surface: WorkspaceDevSurface) => void;
  onOpenStatus?: () => void;
  threadId?: string;
  defaultCatId?: string;
  actions?: ReactNode;
  workspaceSearch?: LauncherWorkspaceSearch;
}) {
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
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

  const selectDestination = (destination: LauncherDestination) => {
    if (destination.kind === 'surface') {
      setWorkspaceMode('dev');
      onSelectDevSurface?.(destination.id);
    } else if (destination.kind === 'mode') {
      setWorkspaceMode(destination.id);
    } else if (destination.kind === 'host') {
      onOpenStatus?.();
    } else if (threadId) {
      openTheaterReplay(threadId);
    }
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
