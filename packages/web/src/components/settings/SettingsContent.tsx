'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { refreshCatsNow, useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { MemberSaveTrace } from '@/utils/member-save-trace';
import { accountsCopy } from '../accounts/accounts.shell-copy';
import type { ConfigData } from '../config-viewer-tabs';
import { DesktopUpdateSettingsPanel } from '../DesktopUpdateSettingsPanel';
import { HubAccountsTab } from '../HubAccountsTab';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { HubEnvFilesTab } from '../HubEnvFilesTab';
import { HubOverviewToolbar } from '../HubMemberOverviewCard';
import { memberSaveCopy } from '../members/member-save.shell-copy';
import { PushSettingsPanel } from '../PushSettingsPanel';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { useConfirm } from '../useConfirm';
import { VoiceSettingsPanel } from '../VoiceSettingsPanel';
import { CatDossierContent } from './CatDossierContent';
import { ConciergeSettingsContent } from './ConciergeSettingsContent';
import { ExecutionRecordDefaultSettings } from './ExecutionRecordDefaultSettings';
import { HubSystemSettingsTab } from './HubSystemSettingsTab';
import { MarketplaceContent } from './MarketplaceContent';
import { McpManageContent } from './McpManageContent';
import { MessageDispositionDefaultSettings } from './MessageDispositionDefaultSettings';
import { MemberSettingsHost } from './members/MemberSettingsHost';
import { OpenTeamWorkspaceButton } from './OpenTeamWorkspaceButton';
import { OpsContent } from './OpsContent';
import { PluginsContent } from './PluginsContent';
import { RulesPromptsContent } from './RulesPromptsContent';
import { ServiceStatusPanel } from './ServiceStatusPanel';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SettingsPlaceholder } from './SettingsPlaceholder';
import { SkillsContent } from './SkillsContent';
import { useSettingsDetailText } from './settings-detail.shell-copy';
import { SETTINGS_SECTIONS } from './settings-nav-config';

interface SettingsContentProps {
  section: string;
  initialEditCatId?: string;
}

export function SettingsContent({ section, initialEditCatId }: SettingsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountsText = useShellCopy(accountsCopy);
  const saveText = useShellCopy(memberSaveCopy);
  const sectionText = useSettingsDetailText();
  const { cats, refresh, isLoading: catsLoading, hasFetched: catsKnown } = useCatData();
  const isV2 = useShellPresentation() === 'v2';
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const confirm = useConfirm();
  const openMember = (cat: (typeof cats)[number] | null) => {
    setEditingCat(cat);
    setEditorOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.set('s', 'members');
    params.delete('returnTo');
    params.delete('manual');
    params.delete('resume');
    if (cat) {
      params.set('cat', cat.id);
      params.delete('view');
    } else {
      params.set('view', 'add');
      params.delete('cat');
    }
    router.push(`/settings?${params.toString()}`, { scroll: false });
  };
  const openMemberSetup = () => {
    setEditingCat(null);
    setEditorOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.set('s', 'members');
    params.set('view', 'setup');
    params.delete('cat');
    params.delete('returnTo');
    params.delete('manual');
    params.delete('resume');
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
    params.delete('manual');
    params.delete('resume');
    router.push(`/settings?${params.toString()}`, { scroll: false });
  };

  const fetchData = useCallback(async (headers?: HeadersInit) => {
    setFetchError(null);
    try {
      const res = await apiFetch('/api/config', headers ? { headers } : undefined);
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
    if (searchParams.get('view') === 'add' || searchParams.get('view') === 'setup') {
      setEditingCat(null);
      setEditorOpen(true);
      return;
    }
    const id = searchParams.get('cat') || initialEditCatId;
    const selected = id ? cats.find((item) => item.id === id) : null;
    setEditingCat(selected ?? null);
    setEditorOpen(Boolean(selected));
  }, [initialEditCatId, section, cats, searchParams]);

  const handleEditorSaved = useCallback(
    async (trace?: MemberSaveTrace) => {
      const [, { cats: updatedCats, fromApi }] = await Promise.all([
        fetchData(trace?.headers()),
        refreshCatsNow(trace?.headers()),
      ]);
      if (editingCat && (!fromApi || !updatedCats.some((cat) => cat.id === editingCat.id))) {
        throw new Error(saveText.readbackFailed);
      }
      setEditingCat((previous) => (previous ? (updatedCats.find((cat) => cat.id === previous.id) ?? previous) : null));
    },
    [fetchData, editingCat, saveText.readbackFailed],
  );

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
      if (!ok) return false;
      setFetchError(null);
      try {
        const res = await apiFetch(`/api/cats/${cat.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setFetchError((payload.error as string) ?? `删除失败 (${res.status})`);
          return false;
        }
        await Promise.all([fetchData(), refresh()]);
        return true;
      } catch {
        setFetchError('删除失败');
        return false;
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

  const pageHeader = {
    title: section === 'accounts' ? accountsText.title : (sectionText(section)?.title ?? meta.label),
    subtitle:
      section === 'accounts'
        ? isV2
          ? undefined
          : accountsText.subtitle
        : isV2
          ? (sectionText(section)?.description ?? meta.description)
          : meta.description,
  };

  const content = (() => {
    switch (meta.id) {
      case 'members':
        return (
          <MemberSettingsHost
            v2={isV2}
            editorOpen={editorOpen}
            editingCat={editingCat}
            cats={cats}
            config={config}
            configError={fetchError}
            registryLoading={catsLoading}
            registryKnown={catsKnown}
            creationView={searchParams.get('view')}
            onRetryConfig={() => void fetchData()}
            onRetryRegistry={() => void refresh()}
            onOpen={openMember}
            onDetect={openMemberSetup}
            onClose={closeMember}
            onTeamCreated={fetchData}
            onSaved={async (saved, trace) => {
              await handleEditorSaved(trace);
              setEditingCat(saved);
            }}
            onEditCoCreator={() => setCoCreatorEditorOpen(true)}
            onDelete={handleDeleteMember}
            onToggle={handleToggleAvailability}
            togglingCatId={togglingCatId}
          />
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
            {isV2 && (
              <ExecutionRecordDefaultSettings
                config={config}
                hasLoadError={fetchError !== null}
                onConfigChange={setConfig}
                onRetry={() => void fetchData()}
              />
            )}
            {isV2 && <MessageDispositionDefaultSettings />}
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
        return <PluginsContent pageHeader={pageHeader} />;
      case 'concierge':
        return <ConciergeSettingsContent />;
      default:
        return <SettingsPlaceholder section={meta.label} description="此分区即将上线" />;
    }
  })();

  return (
    <div className={section === 'members' ? `mx-auto w-full ${editorOpen ? 'max-w-5xl' : 'max-w-6xl'}` : undefined}>
      {!(section === 'members' && (editorOpen || isV2)) && (
        <SettingsPageHeader
          title={section === 'accounts' ? accountsText.title : (sectionText(section)?.title ?? meta.label)}
          subtitle={
            section === 'accounts'
              ? isV2
                ? undefined
                : accountsText.subtitle
              : isV2
                ? (sectionText(section)?.description ?? meta.description)
                : meta.description
          }
        >
          {section === 'members' && config && <HubOverviewToolbar onAddMember={() => openMember(null)} />}
        </SettingsPageHeader>
      )}
      {content}
      {coCreatorEditorOpen && config && (
        <HubCoCreatorEditor
          open
          coCreator={config.coCreator}
          onClose={() => setCoCreatorEditorOpen(false)}
          onSaved={() => handleEditorSaved()}
        />
      )}
    </div>
  );
}
