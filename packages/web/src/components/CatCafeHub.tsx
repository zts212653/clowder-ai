'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { BrakeSettingsPanel } from './BrakeSettingsPanel';
import {
  AccordionSection,
  ALL_TABS,
  findGroupForTab,
  HUB_GROUPS,
  type HubTabId,
  resolveRequestedHubTab,
} from './cat-cafe-hub.navigation';
import { CatOverviewTab, type ConfigData, SystemTab } from './config-viewer-tabs';
import { HubAccountsTab } from './HubAccountsTab';
import { HubCapabilityTab } from './HubCapabilityTab';
import { HubCatEditor } from './HubCatEditor';
import { HubClaudeRescueSection } from './HubClaudeRescueSection';
import { HubCoCreatorEditor } from './HubCoCreatorEditor';
import { HubCommandsTab } from './HubCommandsTab';
import { HubEnvFilesTab } from './HubEnvFilesTab';
import { HubGovernanceTab } from './HubGovernanceTab';
import { HubLeaderboardTab } from './HubLeaderboardTab';
import { HubMemoryTab } from './HubMemoryTab';
import { HubRoutingPolicyTab } from './HubRoutingPolicyTab';
import { HubToolUsageTab } from './HubToolUsageTab';
import { MarketplacePanel } from './marketplace/marketplace-panel';
import { PushSettingsPanel } from './PushSettingsPanel';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';

export type { HubTabId } from './cat-cafe-hub.navigation';
export { findGroupForTab, resolveRequestedHubTab } from './cat-cafe-hub.navigation';

/* ─── Main Hub modal ─── */
export function CatCafeHub() {
  const hubState = useChatStore((s) => s.hubState);
  const closeHub = useChatStore((s) => s.closeHub);
  const guideActive = useGuideStore((s) => s.session !== null);
  const activeGuideStep = useGuideStore((s) => {
    const session = s.session;
    if (!session || session.currentStepIndex >= session.flow.steps.length) return null;
    return session.flow.steps[session.currentStepIndex];
  });
  const { cats, getCatById, refresh } = useCatData();

  const open = hubState?.open ?? false;
  const rawRequestedTab = hubState?.tab as HubTabId | undefined;
  const normalizedRequestedTab = rawRequestedTab ? resolveRequestedHubTab(rawRequestedTab, getCatById) : undefined;

  const [tab, setTab] = useState<HubTabId>('cats');
  const [expandedGroup, setExpandedGroup] = useState<string | null>('cats');
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [capTabEverOpened, setCapTabEverOpened] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [createDraft, setCreateDraft] = useState<Parameters<typeof HubCatEditor>[0]['draft']>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);

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

  const toggleGroup = useCallback(
    (groupId: string) => {
      setExpandedGroup((prev) => {
        const isGuideLockedToggle =
          prev === groupId && activeGuideStep?.advance === 'click' && activeGuideStep.target === `${groupId}.group`;
        if (isGuideLockedToggle) return prev;
        return prev === groupId ? null : groupId;
      });
    },
    [activeGuideStep],
  );

  const selectTab = useCallback((tabId: HubTabId) => {
    setTab(tabId);
  }, []);

  const openAddMember = useCallback(() => {
    setEditingCat(null);
    setCreateDraft(null);
    setEditorOpen(true);
  }, []);

  const openEditMember = useCallback((cat: (typeof cats)[number]) => {
    setCreateDraft(null);
    setEditingCat(cat);
    setEditorOpen(true);
  }, []);

  const openCoCreatorEditor = useCallback(() => {
    setCoCreatorEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditingCat(null);
    setCreateDraft(null);
  }, []);

  const closeCoCreatorEditor = useCallback(() => {
    setCoCreatorEditorOpen(false);
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

  const handleToggleAvailability = useCallback(
    async (cat: (typeof cats)[number]) => {
      setTogglingCatId(cat.id);
      setFetchError(null);
      try {
        const res = await apiFetch(`/api/cats/${cat.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ available: cat.roster?.available === false }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setFetchError((payload.error as string) ?? `成员状态切换失败 (${res.status})`);
          return;
        }
        await Promise.all([fetchData(), refresh()]);
      } catch {
        setFetchError('成员状态切换失败');
      } finally {
        setTogglingCatId(null);
      }
    },
    [fetchData, refresh],
  );

  useEffect(() => {
    if (open) fetchData();
  }, [open, fetchData]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      // Skip Escape when guide overlay is active to prevent accidental exit (KD-14)
      if (e.key === 'Escape' && !guideActive) closeHub();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, closeHub, guideActive]);

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
          <h2 className="text-base font-bold text-cafe">Cat Caf&eacute; Hub</h2>
          <button
            type="button"
            onClick={closeHub}
            className="text-cafe-muted hover:text-cafe-secondary text-lg"
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
          <div className="rounded-xl bg-cafe-surface shadow-[0_1px_8px_rgba(0,0,0,0.03)] p-4">
            {(tab === 'capabilities' || capTabEverOpened) && (
              <div className={tab === 'capabilities' ? '' : 'hidden'}>
                <HubCapabilityTab />
              </div>
            )}
            {tab === 'cats' &&
              (config ? (
                <CatOverviewTab
                  config={config}
                  cats={cats}
                  onAddMember={openAddMember}
                  onEditCoCreator={openCoCreatorEditor}
                  onEditMember={openEditMember}
                  onToggleAvailability={handleToggleAvailability}
                  togglingCatId={togglingCatId}
                />
              ) : !fetchError ? (
                <p className="text-sm text-cafe-muted">加载中...</p>
              ) : null)}
            {tab === 'system' &&
              (config ? (
                <SystemTab config={config} onConfigChange={fetchData} />
              ) : !fetchError ? (
                <p className="text-sm text-cafe-muted">加载中...</p>
              ) : null)}
            {tab === 'commands' && <HubCommandsTab />}
            {tab === 'routing' && <HubRoutingPolicyTab />}
            {tab === 'tool-usage' && <HubToolUsageTab />}
            {tab === 'env' && <HubEnvFilesTab />}
            {tab === 'accounts' && <HubAccountsTab />}
            {tab === 'voice' && <VoiceSettingsPanel />}
            {tab === 'notify' && <PushSettingsPanel />}
            {tab === 'governance' && <HubGovernanceTab />}
            {tab === 'health' && <BrakeSettingsPanel />}
            {tab === 'memory' && <HubMemoryTab />}
            {tab === 'rescue' && <HubClaudeRescueSection />}
            {tab === 'leaderboard' && <HubLeaderboardTab />}
            {tab === 'marketplace' && <MarketplacePanel />}
          </div>
        </div>
        <HubCatEditor
          open={editorOpen}
          cat={editingCat}
          draft={createDraft}
          onClose={closeEditor}
          onSaved={handleEditorSaved}
        />
        <HubCoCreatorEditor
          open={coCreatorEditorOpen}
          coCreator={config?.coCreator}
          onClose={closeCoCreatorEditor}
          onSaved={handleEditorSaved}
        />
      </div>
    </div>
  );
}
