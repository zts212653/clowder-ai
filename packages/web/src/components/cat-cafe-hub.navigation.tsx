'use client';

import { ChevronIcon, HubIcon } from './hub-icons';

export type HubTabId = string;

interface HubTab {
  id: HubTabId;
  label: string;
  icon: string;
}

export interface HubGroup {
  id: string;
  label: string;
  icon: string;
  color: string;
  preview: string;
  tabs: HubTab[];
}

export const HUB_GROUPS: HubGroup[] = [
  {
    id: 'cats',
    label: '成员协作',
    icon: 'cat',
    color: '#9B7EBD',
    preview: '总览 · 能力 · 配额 · 工具 · 排行',
    tabs: [
      { id: 'cats', label: '总览', icon: 'users' },
      { id: 'capabilities', label: '能力中心', icon: 'sparkles' },
      { id: 'routing', label: '配额看板', icon: 'chart-pie' },
      { id: 'tool-usage', label: '工具统计', icon: 'wrench' },
      { id: 'leaderboard', label: '排行榜', icon: 'trophy' },
      { id: 'marketplace', label: '能力市场', icon: 'store' },
    ],
  },
  {
    id: 'settings',
    label: '系统配置',
    icon: 'settings',
    color: '#E29578',
    preview: '账号 · 语音 · 通知',
    tabs: [
      { id: 'system', label: '系统配置', icon: 'settings' },
      { id: 'env', label: '环境 & 文件', icon: 'folder' },
      { id: 'accounts', label: '账号配置', icon: 'user-cog' },
      { id: 'voice', label: '语音设置', icon: 'mic' },
      { id: 'notify', label: '通知', icon: 'bell' },
    ],
  },
  {
    id: 'monitor',
    label: '监控与治理',
    icon: 'activity',
    color: '#5B9BD5',
    preview: '治理 · 健康 · 记忆 · 救援 · 命令速查',
    tabs: [
      { id: 'governance', label: '治理看板', icon: 'shield' },
      { id: 'health', label: '健康', icon: 'heart-pulse' },
      { id: 'memory', label: '记忆状态', icon: 'brain' },
      { id: 'rescue', label: '布偶猫救援', icon: 'activity' },
      { id: 'commands', label: '命令速查', icon: 'terminal' },
    ],
  },
];

export const ALL_TABS = HUB_GROUPS.flatMap((group) => group.tabs);

export function findGroupForTab(tabId: string): HubGroup | undefined {
  return HUB_GROUPS.find((group) => group.tabs.some((tab) => tab.id === tabId));
}

export function resolveRequestedHubTab(requestedTab: string, getCatById: (catId: string) => unknown): HubTabId {
  if (requestedTab === 'quota') return 'routing';
  if (requestedTab === 'strategy') return 'cats';
  if (getCatById(requestedTab)) return 'cats';
  return requestedTab;
}

export function AccordionSection({
  group,
  expanded,
  activeTab,
  onToggle,
  onSelectTab,
}: {
  group: HubGroup;
  expanded: boolean;
  activeTab: HubTabId;
  onToggle: () => void;
  onSelectTab: (tabId: HubTabId) => void;
}) {
  return (
    <div className="rounded-xl bg-cafe-surface shadow-[0_1px_8px_rgba(0,0,0,0.03)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-cafe-surface-elevated/50"
        data-guide-id={group.id === 'settings' ? 'settings.group' : undefined}
      >
        <span className="flex-shrink-0" style={{ color: group.color }}>
          <HubIcon name={group.icon} className="h-5 w-5" />
        </span>
        <span className="text-sm font-semibold text-cafe">{group.label}</span>
        <span className="flex-1" />
        {!expanded ? (
          <span className="hidden max-w-[180px] truncate text-xs text-cafe-muted sm:inline">{group.preview}</span>
        ) : null}
        <span
          className="min-w-[20px] rounded-full px-1.5 py-0.5 text-center text-xs font-medium"
          style={{ color: group.color, backgroundColor: `${group.color}15` }}
        >
          {group.tabs.length}
        </span>
        <ChevronIcon expanded={expanded} className="h-4 w-4 flex-shrink-0 text-cafe-muted" />
      </button>

      {expanded ? (
        <div className="px-2 pb-2">
          {group.tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-sm transition-colors"
                style={isActive ? { backgroundColor: `${group.color}10`, color: group.color } : {}}
                data-guide-id={
                  tab.id === 'cats' ? 'cats.overview' : tab.id === 'accounts' ? 'settings.accounts' : undefined
                }
              >
                <span style={isActive ? { color: group.color } : { color: '#9ca3af' }}>
                  <HubIcon name={tab.icon} className="h-4 w-4" />
                </span>
                <span className={isActive ? 'font-medium' : 'text-cafe-secondary'}>{tab.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
