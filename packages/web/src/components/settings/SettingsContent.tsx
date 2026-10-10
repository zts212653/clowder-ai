'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { RoutingContextLedger } from '@/components/routing-context/RoutingContextLedger';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { ConnectorPluginInstallButton } from '../ConnectorPluginInstallButton';
import { CatOverviewTab, type ConfigData } from '../config-viewer-tabs';
import { DesktopUpdateSettingsPanel } from '../DesktopUpdateSettingsPanel';
import { HubAccountsTab } from '../HubAccountsTab';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { HubConnectorConfigTab } from '../HubConnectorConfigTab';
import { HubEnvFilesTab } from '../HubEnvFilesTab';
import { HubOverviewToolbar } from '../HubMemberOverviewCard';
import { PushSettingsPanel } from '../PushSettingsPanel';
import { useConfirm } from '../useConfirm';
import { VoiceSettingsPanel } from '../VoiceSettingsPanel';
import { CatDossierContent } from './CatDossierContent';
import { ConciergeSettingsContent } from './ConciergeSettingsContent';
import { HubSystemSettingsTab } from './HubSystemSettingsTab';
import { MarketplaceContent } from './MarketplaceContent';
import { McpManageContent } from './McpManageContent';
import { MemberSettingsPage } from './members/MemberSettingsPage';
import { OpenTeamWorkspaceButton } from './OpenTeamWorkspaceButton';
import { OpsContent } from './OpsContent';
import { PluginsContent } from './PluginsContent';
import { SettingsText } from './primitives';
import { RulesPromptsContent } from './RulesPromptsContent';
import { ServiceStatusPanel } from './ServiceStatusPanel';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SettingsPlaceholder } from './SettingsPlaceholder';
import { SkillsContent } from './SkillsContent';
import { SETTINGS_SECTIONS } from './settings-nav-config';

interface SettingsContentProps {
  section: string;
  initialEditCatId?: string;
}

export function SettingsContent({ section, initialEditCatId }: SettingsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { cats, refresh } = useCatData();
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const [imRefreshKey, setImRefreshKey] = useState(0);
  const confirm = useConfirm();
  const openMember = (cat: (typeof cats)[number] | null) => {
    setEditingCat(cat);
    setEditorOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.set('s', 'members');
    params.delete('returnTo');
    if (cat) {
      params.set('cat', cat.id);
      params.delete('view');
    } else {
      params.set('view', 'add');
      params.delete('cat');
    }
    router.push(`/settings?${params.toString()}`, { scroll: false });
  };
  const closeMember = () => {
    setEditorOpen(false);
    setEditingCat(null);
    const params = new URLSearchParams(searchParams.toString());
    params.set('s', 'members');
    params.delete('cat');
    params.delete('view');
    params.delete('returnTo');
    router.push(`/settings?${params.toString()}`, { scroll: false });
  };

  const fetchData = useCallback(async () => {
    setFetchError(null);
    try {
      const res = await apiFetch('/api/config');
      if (!res.ok) {
        setFetchError(`配置加载失败 (${res.status})`);
        return;
      }
      const payload = (await res.json()) as { config: ConfigData };
      setConfig(payload.config);
    } catch {
      setFetchError('配置加载失败');
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (section !== 'members') return;
    if (searchParams.get('view') === 'add') {
      setEditingCat(null);
      setEditorOpen(true);
      return;
    }
    const id = searchParams.get('cat') || initialEditCatId;
    const selected = id ? cats.find((item) => item.id === id) : null;
    setEditingCat(selected ?? null);
    setEditorOpen(Boolean(selected));
  }, [initialEditCatId, section, cats, searchParams]);

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

  const handleDeleteMember = useCallback(
    async (cat: (typeof cats)[number]) => {
      const ok = await confirm({
        title: '删除确认',
        message: `确认删除成员「${cat.displayName}」吗？此操作不可撤销。`,
        variant: 'danger',
        confirmLabel: '删除',
      });
      if (!ok) return;
      setFetchError(null);
      try {
        const res = await apiFetch(`/api/cats/${cat.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setFetchError((payload.error as string) ?? `删除失败 (${res.status})`);
          return;
        }
        await Promise.all([fetchData(), refresh()]);
      } catch {
        setFetchError('删除失败');
      }
    },
    [confirm, fetchData, refresh],
  );

  if (section === 'marketplace') return <MarketplaceContent />;
  if (section === 'skills') return <SkillsContent />;
  if (section === 'profiles') {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <OpenTeamWorkspaceButton />
        </div>
        <CatDossierContent />
      </div>
    );
  }

  const meta = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0];

  const content = (() => {
    switch (meta.id) {
      case 'members':
        if (editorOpen)
          return (
            <MemberSettingsPage
              key={editingCat?.id ?? 'new'}
              cat={editingCat}
              cats={cats}
              onBack={closeMember}
              onSaved={async (saved) => {
                await handleEditorSaved();
                if (!editingCat) closeMember();
                else setEditingCat(saved);
              }}
            />
          );
        return (
          <div className="space-y-8">
            {fetchError ? (
              <SettingsText as="p" variant="sm" tone="red">
                {fetchError}
              </SettingsText>
            ) : config ? (
              <CatOverviewTab
                config={config}
                cats={cats}
                onEditMember={openMember}
                onEditCoCreator={() => setCoCreatorEditorOpen(true)}
                onDeleteMember={handleDeleteMember}
                onToggleAvailability={handleToggleAvailability}
                togglingCatId={togglingCatId}
              />
            ) : (
              <SettingsText as="p" variant="sm" tone="muted">
                加载中...
              </SettingsText>
            )}
            <div className="space-y-3">
              <div className="flex justify-end">
                <OpenTeamWorkspaceButton />
              </div>
              <details className="rounded-xl border border-[var(--console-border-soft)] p-4">
                <summary className="cursor-pointer text-sm text-cafe-secondary">查看路由记录</summary>
                <div className="mt-4">
                  <RoutingContextLedger />
                </div>
              </details>
            </div>
          </div>
        );
      case 'accounts':
        return (
          <div className="space-y-4">
            {searchParams.get('returnTo')?.startsWith('/settings?') && (
              <Link
                className="inline-flex min-h-11 items-center text-sm text-cafe-accent"
                href={searchParams.get('returnTo') ?? '/settings?s=members'}
              >
                {searchParams.get('lang') === 'en' ? '← Back to member' : '← 返回成员编辑'}
              </Link>
            )}
            <HubAccountsTab
              initialClientId={(['anthropic', 'openai', 'google', 'kimi', 'opencode', 'acp'] as const).find(
                (value) => value === searchParams.get('client'),
              )}
              toolLabel={searchParams.get('tool') ?? undefined}
            />
          </div>
        );
      case 'im':
        return <HubConnectorConfigTab refreshKey={imRefreshKey} />;
      case 'voice':
        return (
          <div className="space-y-6">
            <ServiceStatusPanel
              filterFeatures={[
                'voice-input',
                'voice-output',
                'voice-companion',
                'voice-postprocess',
                'meeting-copilot',
                'live-transcript',
              ]}
              title="语音服务"
            />
            <VoiceSettingsPanel />
          </div>
        );
      case 'system':
        return (
          <div className="space-y-6">
            <DesktopUpdateSettingsPanel />
            <HubSystemSettingsTab />
            <HubEnvFilesTab excludeCategories={['connector']} />
          </div>
        );
      case 'notify':
        return <PushSettingsPanel />;
      case 'ops':
        return <OpsContent />;
      case 'rules':
        return <RulesPromptsContent />;
      case 'mcp':
        return <McpManageContent />;
      case 'plugins':
        return <PluginsContent />;
      case 'concierge':
        return <ConciergeSettingsContent />;
      default:
        return <SettingsPlaceholder section={meta.label} description="此分区即将上线" />;
    }
  })();

  return (
    <>
      {!(section === 'members' && editorOpen) && (
        <SettingsPageHeader title={meta.label} subtitle={meta.description}>
          {section === 'members' && config && <HubOverviewToolbar onAddMember={() => openMember(null)} />}
          {section === 'im' && <ConnectorPluginInstallButton onInstalled={() => setImRefreshKey((k) => k + 1)} />}
        </SettingsPageHeader>
      )}
      {content}
      {coCreatorEditorOpen && config && (
        <HubCoCreatorEditor
          open
          coCreator={config.coCreator}
          onClose={() => setCoCreatorEditorOpen(false)}
          onSaved={handleEditorSaved}
        />
      )}
    </>
  );
}
