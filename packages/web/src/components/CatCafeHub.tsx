'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { BrakeSettingsPanel } from './BrakeSettingsPanel';
import { HubClaudeRescueSection } from './HubClaudeRescueSection';
import { HubAddMemberWizard } from './HubAddMemberWizard';
import { CatOverviewTab, type ConfigData, SystemTab } from './config-viewer-tabs';
import { HubCapabilityTab } from './HubCapabilityTab';
import { HubCommandsTab } from './HubCommandsTab';
import { HubCatEditor } from './HubCatEditor';
import { HubEnvFilesTab } from './HubEnvFilesTab';
import { HubGovernanceTab } from './HubGovernanceTab';
import { HubLeaderboardTab } from './HubLeaderboardTab';
import { HubProviderProfilesTab } from './HubProviderProfilesTab';
import { HubRoutingPolicyTab } from './HubRoutingPolicyTab';
import { ChevronIcon, HubIcon } from './hub-icons';
import { PushSettingsPanel } from './PushSettingsPanel';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';
export type HubTabId = string;

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
    label: '成员协作',
    icon: 'cat',
    color: '#9B7EBD',
    preview: '总览 · 能力 · 配额 · 排行',
    tabs: [
      { id: 'cats', label: '总览', icon: 'users' },
      { id: 'capabilities', label: '能力中心', icon: 'sparkles' },
      { id: 'routing', label: '配额看板', icon: 'chart-pie' },
      { id: 'leaderboard', label: '排行榜', icon: 'trophy' },
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
      { id: 'provider-profiles', label: '账号配置', icon: 'user-cog' },
      { id: 'voice', label: '语音设置', icon: 'mic' },
      { id: 'notify', label: '通知', icon: 'bell' },
    ],
  },
  {
    id: 'monitor',
    label: '监控与治理',
    icon: 'activity',
    color: '#5B9BD5',
    preview: '治理 · 健康 · 救援 · 命令速查',
    tabs: [
      { id: 'governance', label: '治理看板', icon: 'shield' },
      { id: 'health', label: '健康', icon: 'heart-pulse' },
      { id: 'rescue', label: '布偶猫救援', icon: 'activity' },
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
  if (requestedTab === 'strategy') return 'cats';
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
  const { cats, getCatById, refresh } = useCatData();

  const open = hubState?.open ?? false;
  const rawRequestedTab = hubState?.tab as HubTabId | undefined;
  const normalizedRequestedTab = rawRequestedTab ? resolveRequestedHubTab(rawRequestedTab, getCatById) : undefined;

  const [tab, setTab] = useState<HubTabId>('cats');
  const [expandedGroup, setExpandedGroup] = useState<string | null>('cats');
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [capTabEverOpened, setCapTabEverOpened] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [createDraft, setCreateDraft] = useState<Parameters<typeof HubCatEditor>[0]['draft']>(null);

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

  const openAddMember = useCallback(() => {
    setEditingCat(null);
    setCreateDraft(null);
    setWizardOpen(true);
  }, []);

  const openEditMember = useCallback((cat: (typeof cats)[number]) => {
    setCreateDraft(null);
    setWizardOpen(false);
    setEditingCat(cat);
    setEditorOpen(true);
  }, []);

  const handleCreateFlowComplete = useCallback((draft: Parameters<typeof HubCatEditor>[0]['draft']) => {
    setCreateDraft(draft);
    setWizardOpen(false);
    setEditingCat(null);
    setEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditingCat(null);
    setCreateDraft(null);
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

  const handleEditorSaved = useCallback(async () => {
    await Promise.all([fetchData(), refresh()]);
  }, [fetchData, refresh]);

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
                <CatOverviewTab config={config} cats={cats} onAddMember={openAddMember} onEditMember={openEditMember} />
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
            {tab === 'governance' && <HubGovernanceTab />}
            {tab === 'health' && <BrakeSettingsPanel />}
            {tab === 'rescue' && <HubClaudeRescueSection />}
            {tab === 'leaderboard' && <HubLeaderboardTab />}
          </div>
        </div>
        <HubAddMemberWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onComplete={handleCreateFlowComplete} />
        <HubCatEditor open={editorOpen} cat={editingCat} draft={createDraft} onClose={closeEditor} onSaved={handleEditorSaved} />
      </div>
    </div>
  );
}
