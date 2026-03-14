'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { BrakeSettingsPanel } from './BrakeSettingsPanel';
import { CatOverviewTab, type ConfigData, SystemTab } from './config-viewer-tabs';
import { HubCapabilityTab } from './HubCapabilityTab';
import { HubCommandsTab } from './HubCommandsTab';
import { HubEnvFilesTab } from './HubEnvFilesTab';
import { HubGovernanceTab } from './HubGovernanceTab';
import { HubLeaderboardTab } from './HubLeaderboardTab';
import { HubProviderProfilesTab } from './HubProviderProfilesTab';
import { HubRoutingPolicyTab } from './HubRoutingPolicyTab';
import { HubStrategyTab } from './HubStrategyTab';
import { PushSettingsPanel } from './PushSettingsPanel';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';

export type HubTabId = string;

/* ─── SVG icon paths (Lucide-compatible, 24×24 viewBox) ─── */
const ICON_PATHS: Record<string, string> = {
  cat: 'M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.1 6.95-.45a4 4 0 0 1 .53.6c.91 1.21 1.12 2.71.67 4.17-.63 2.05-2.19 3.48-3.95 4.13C18.34 16.21 15.8 18 12 18c-3.8 0-6.34-1.79-6.2-4.29-1.76-.65-3.32-2.08-3.95-4.13-.45-1.46-.24-2.96.67-4.17.17-.23.34-.44.53-.6 1.92-1.65 5.17-1.55 6.95.45.65-.17 1.33-.26 2-.26zM8 11.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0zM14 11.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0zM9.5 15.5a3.5 3.5 0 0 0 5 0',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6z',
  activity:
    'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36-3.18-11.64A2 2 0 0 0 10.13 9H9.87a2 2 0 0 0-1.93 1.46L6.59 15H2',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  sparkles:
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.064 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4',
  'chart-pie':
    'M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95V12h9zM21.95 13.001c.055.55-.398.998-.95.998H12V5.002c0-.552-.449-1.005-.998-.95A10 10 0 1 0 21.95 13.002z',
  trophy:
    'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2z',
  folder:
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
  'user-cog':
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19.7 14.4l-.9-.3a2 2 0 0 1 0-3.8l.9-.3a.5.5 0 0 0 .2-.8l-.6-.7a2 2 0 0 1-2.7-2.7l-.7-.6a.5.5 0 0 0-.8.2l-.3.9a2 2 0 0 1-3.8 0l-.3-.9a.5.5 0 0 0-.8-.2',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  shield:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  'heart-pulse': 'M19.5 12.572l-7.5 7.428-7.5-7.428A5 5 0 0 1 12 6.006a5 5 0 0 1 7.5 6.572zM12 6l1 5h2l1-2 1.5 4H21',
  terminal: 'M4 17l6-6-6-6M12 19h8',
};

function HubIcon({ name, className = 'w-5 h-5' }: { name: string; className?: string }) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

function ChevronIcon({ expanded, className = 'w-4 h-4' }: { expanded: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

/* ─── Group + tab data ─── */
interface HubTab {
  id: HubTabId;
  label: string;
  icon: string;
}

interface HubGroup {
  id: string;
  label: string;
  icon: string;
  color: string; // hex breed color
  preview: string;
  tabs: HubTab[];
}

const HUB_GROUPS: HubGroup[] = [
  {
    id: 'cats',
    label: '猫猫与协作',
    icon: 'cat',
    color: '#9B7EBD',
    preview: '总览 · 能力 · 猫粮 · 排行',
    tabs: [
      { id: 'cats', label: '猫猫总览', icon: 'users' },
      { id: 'capabilities', label: '能力中心', icon: 'sparkles' },
      { id: 'routing', label: '猫粮看板', icon: 'chart-pie' },
      { id: 'leaderboard', label: '排行榜', icon: 'trophy' },
    ],
  },
  {
    id: 'settings',
    label: '系统配置',
    icon: 'settings',
    color: '#E29578',
    preview: '账号 · 语音 · 通知 · Session',
    tabs: [
      { id: 'system', label: '系统配置', icon: 'settings' },
      { id: 'env', label: '环境 & 文件', icon: 'folder' },
      { id: 'provider-profiles', label: '账号配置', icon: 'user-cog' },
      { id: 'voice', label: '语音设置', icon: 'mic' },
      { id: 'notify', label: '通知', icon: 'bell' },
      { id: 'strategy', label: 'Session 策略', icon: 'timer' },
    ],
  },
  {
    id: 'monitor',
    label: '监控与治理',
    icon: 'activity',
    color: '#5B9BD5',
    preview: '治理 · 健康 · 命令速查',
    tabs: [
      { id: 'governance', label: '治理看板', icon: 'shield' },
      { id: 'health', label: '健康', icon: 'heart-pulse' },
      { id: 'commands', label: '命令速查', icon: 'terminal' },
    ],
  },
];

const ALL_TABS = HUB_GROUPS.flatMap((g) => g.tabs);

/** Find which group a tab belongs to */
export function findGroupForTab(tabId: string): HubGroup | undefined {
  return HUB_GROUPS.find((g) => g.tabs.some((t) => t.id === tabId));
}

export function resolveRequestedHubTab(requestedTab: string, getCatById: (catId: string) => unknown): HubTabId {
  if (requestedTab === 'quota') return 'routing';
  if (getCatById(requestedTab)) return 'cats';
  return requestedTab;
}

/* ─── Accordion section ─── */
function AccordionSection({
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
    <div className="rounded-xl bg-white shadow-[0_1px_8px_rgba(0,0,0,0.03)]">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50/50 rounded-xl transition-colors"
      >
        <span className="flex-shrink-0" style={{ color: group.color }}>
          <HubIcon name={group.icon} className="w-5 h-5" />
        </span>
        <span className="font-semibold text-sm text-gray-900">{group.label}</span>
        <span className="flex-1" />
        {!expanded && (
          <span className="text-xs text-gray-400 truncate max-w-[180px] hidden sm:inline">{group.preview}</span>
        )}
        <span
          className="text-xs font-medium rounded-full px-1.5 py-0.5 min-w-[20px] text-center"
          style={{ color: group.color, backgroundColor: `${group.color}15` }}
        >
          {group.tabs.length}
        </span>
        <ChevronIcon expanded={expanded} className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>

      {/* Expanded sub-items */}
      {expanded && (
        <div className="pb-2 px-2">
          {group.tabs.map((t) => {
            const isActive = t.id === activeTab;
            return (
              <button
                key={t.id}
                onClick={() => onSelectTab(t.id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-left transition-colors text-sm"
                style={isActive ? { backgroundColor: `${group.color}10`, color: group.color } : {}}
              >
                <span style={isActive ? { color: group.color } : { color: '#9ca3af' }}>
                  <HubIcon name={t.icon} className="w-4 h-4" />
                </span>
                <span className={isActive ? 'font-medium' : 'text-gray-600'}>{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Main Hub modal ─── */
export function CatCafeHub() {
  const hubState = useChatStore((s) => s.hubState);
  const closeHub = useChatStore((s) => s.closeHub);
  const { cats, getCatById } = useCatData();

  const open = hubState?.open ?? false;
  const rawRequestedTab = hubState?.tab as HubTabId | undefined;
  const normalizedRequestedTab = rawRequestedTab ? resolveRequestedHubTab(rawRequestedTab, getCatById) : undefined;

  const [tab, setTab] = useState<HubTabId>('cats');
  const [expandedGroup, setExpandedGroup] = useState<string | null>('cats');
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [capTabEverOpened, setCapTabEverOpened] = useState(false);

  // P1 fix: Render-time state sync (React 18 "adjusting state on props change" pattern).
  // Avoids first-frame flash that useEffect would cause on deep-link opens.
  const [lastSyncKey, setLastSyncKey] = useState('');
  const syncKey = open ? `open:${normalizedRequestedTab ?? ''}` : 'closed';
  if (syncKey !== lastSyncKey) {
    setLastSyncKey(syncKey);
    if (open) {
      if (!normalizedRequestedTab) {
        setExpandedGroup('cats');
        setTab('cats');
      } else {
        const group = findGroupForTab(normalizedRequestedTab);
        setExpandedGroup(group?.id ?? 'cats');
        setTab(group ? normalizedRequestedTab : 'cats');
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const isValid = ALL_TABS.some((t) => t.id === tab);
    if (!isValid) setTab('cats');
  }, [open, tab]);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroup((prev) => (prev === groupId ? null : groupId));
  }, []);

  const selectTab = useCallback((tabId: HubTabId) => {
    setTab(tabId);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (tab === 'capabilities') setCapTabEverOpened(true);
  }, [open, tab]);

  const fetchData = useCallback(async () => {
    setFetchError(null);
    try {
      const res = await apiFetch('/api/config');
      if (res.ok) {
        const d = (await res.json()) as { config: ConfigData };
        setConfig(d.config);
      } else {
        setFetchError('配置加载失败');
      }
    } catch {
      setFetchError('网络错误');
    }
  }, []);

  useEffect(() => {
    if (open) fetchData();
  }, [open, fetchData]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHub();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, closeHub]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={closeHub}>
      <div
        className="rounded-2xl shadow-xl max-w-4xl w-full mx-4 h-[85vh] flex flex-col"
        style={{ backgroundColor: '#FDF8F3' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3" style={{ flexShrink: 0 }}>
          <h2 className="text-base font-bold text-gray-900">Cat Caf&eacute; Hub</h2>
          <button
            onClick={closeHub}
            className="text-gray-400 hover:text-gray-600 text-lg"
            title="关闭"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3" style={{ minHeight: 0 }}>
          {fetchError && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{fetchError}</p>}

          {/* Accordion navigation */}
          <div className="space-y-2">
            {HUB_GROUPS.map((g) => (
              <AccordionSection
                key={g.id}
                group={g}
                expanded={expandedGroup === g.id}
                activeTab={tab}
                onToggle={() => toggleGroup(g.id)}
                onSelectTab={selectTab}
              />
            ))}
          </div>

          {/* Tab content */}
          <div className="rounded-xl bg-white shadow-[0_1px_8px_rgba(0,0,0,0.03)] p-4">
            {(tab === 'capabilities' || capTabEverOpened) && (
              <div className={tab === 'capabilities' ? '' : 'hidden'}>
                <HubCapabilityTab />
              </div>
            )}
            {tab === 'cats' &&
              (config ? (
                <CatOverviewTab config={config} cats={cats} />
              ) : !fetchError ? (
                <p className="text-sm text-gray-400">加载中...</p>
              ) : null)}
            {tab === 'system' &&
              (config ? (
                <SystemTab config={config} />
              ) : !fetchError ? (
                <p className="text-sm text-gray-400">加载中...</p>
              ) : null)}
            {tab === 'commands' && <HubCommandsTab />}
            {tab === 'routing' && <HubRoutingPolicyTab />}
            {tab === 'env' && <HubEnvFilesTab />}
            {tab === 'provider-profiles' && <HubProviderProfilesTab />}
            {tab === 'voice' && <VoiceSettingsPanel />}
            {tab === 'notify' && <PushSettingsPanel />}
            {tab === 'strategy' && <HubStrategyTab />}
            {tab === 'governance' && <HubGovernanceTab />}
            {tab === 'health' && <BrakeSettingsPanel />}
            {tab === 'leaderboard' && <HubLeaderboardTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
