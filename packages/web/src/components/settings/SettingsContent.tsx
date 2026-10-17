'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refreshCatsNow, useCatData } from '@/hooks/useCatData';
import { catDossierCoversStrengths, useDossierProfiles } from '@/hooks/useDossierProfiles';
import { apiFetch } from '@/utils/api-client';
import { accountsCopy } from '../accounts/accounts.shell-copy';
import { CatOverviewTab, type ConfigData } from '../config-viewer-tabs';
import { DesktopUpdateSettingsPanel } from '../DesktopUpdateSettingsPanel';
import { HubAccountsTab } from '../HubAccountsTab';
import { HubCatEditor } from '../HubCatEditor';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { HubEnvFilesTab } from '../HubEnvFilesTab';
import { MemberCopyProvider } from '../members/editor-presentation';
import { type MemberDeleteCopy, MemberEditorHost } from '../members/MemberEditorHost';
import { MemberListHost } from '../members/MemberListHost';
import { memberSaveCopy } from '../members/member-save.shell-copy';
import { useMemberReturn } from '../members/useMemberReturn';
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
import { OpenTeamWorkspaceButton } from './OpenTeamWorkspaceButton';
import { OpsContent } from './OpsContent';
import { PluginsContent } from './PluginsContent';
import { SettingsText } from './primitives';
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
  const accountsText = useShellCopy(accountsCopy);
  const saveText = useShellCopy(memberSaveCopy);
  const sectionText = useSettingsDetailText();
  const { cats, refresh, isLoading: catsLoading, hasFetched: catsKnown } = useCatData();
  const isV2 = useShellPresentation() === 'v2';
  const memberReturn = useMemberReturn();
  const closeMember = () => {
    setEditorOpen(false);
    setEditingCat(null);
    setCreateDraft(null);
    memberReturn.restore();
  };
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [createDraft, setCreateDraft] = useState<Parameters<typeof HubCatEditor>[0]['draft']>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const confirm = useConfirm();

  // F208 OQ-9: per-field check — badge only when dossier l0RosterSummary covers teamStrengths (KD-14)
  const { data: dossierData } = useDossierProfiles();
  const editingCatHasDossier = useMemo(
    () => (editingCat ? catDossierCoversStrengths(editingCat.id, dossierData) : false),
    [editingCat, dossierData],
  );

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

  const consumedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      initialEditCatId &&
      section === 'members' &&
      cats.length > 0 &&
      consumedDeepLinkRef.current !== initialEditCatId
    ) {
      const cat = cats.find((c) => c.id === initialEditCatId);
      if (cat) {
        consumedDeepLinkRef.current = initialEditCatId;
        setCreateDraft(null);
        setEditingCat(cat);
        setEditorOpen(true);
      }
    }
  }, [initialEditCatId, section, cats]);

  const handleEditorSaved = useCallback(async () => {
    const [, { cats: updatedCats, fromApi }] = await Promise.all([fetchData(), refreshCatsNow()]);
    if (editingCat && (!fromApi || !updatedCats.some((cat) => cat.id === editingCat.id))) {
      throw new Error(saveText.readbackFailed);
    }
    setEditingCat((previous) => (previous ? (updatedCats.find((cat) => cat.id === previous.id) ?? previous) : null));
  }, [fetchData, editingCat, saveText.readbackFailed]);

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
    async (cat: (typeof cats)[number], copy?: MemberDeleteCopy) => {
      const ok = await confirm({
        title: copy ? copy.deleteTitle : '删除确认',
        message: copy ? copy.deletePrompt(cat.displayName) : `确认删除成员「${cat.displayName}」吗？此操作不可撤销。`,
        variant: 'danger',
        confirmLabel: copy ? copy.deleteLabel : '删除',
        ...(copy ? { cancelLabel: copy.取消 } : {}),
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
        if (isV2)
          return (
            <div ref={memberReturn.host}>
              {fetchError && (config || editorOpen) && <p role="alert">{fetchError}</p>}
              <MemberListHost
                hidden={editorOpen}
                registryLoading={catsLoading}
                registryKnown={catsKnown}
                onRetryRegistry={() => void refresh()}
                config={config}
                configError={fetchError}
                onRetryConfig={() => void fetchData()}
                cats={cats}
                onAdd={() => {
                  memberReturn.remember();
                  setEditingCat(null);
                  setCreateDraft(null);
                  setEditorOpen(true);
                }}
                onEdit={(cat) => {
                  memberReturn.remember();
                  setEditingCat(cat);
                  setCreateDraft(null);
                  setEditorOpen(true);
                }}
                onEditCoCreator={() => setCoCreatorEditorOpen(true)}
                onToggle={handleToggleAvailability}
                togglingCatId={togglingCatId}
              />
            </div>
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
                onAddMember={() => {
                  setEditingCat(null);
                  setCreateDraft(null);
                  setEditorOpen(true);
                }}
                onEditMember={(cat) => {
                  setCreateDraft(null);
                  setEditingCat(cat);
                  setEditorOpen(true);
                }}
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
            </div>
          </div>
        );
      case 'accounts':
        return <HubAccountsTab />;
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

  const editor = (
    <MemberEditorHost
      v2={isV2 && section === 'members'}
      cat={editingCat}
      cats={cats}
      draft={createDraft}
      hasDossier={editingCatHasDossier}
      onClose={closeMember}
      onSaved={handleEditorSaved}
      onToggle={handleToggleAvailability}
      togglingCatId={togglingCatId}
      onDelete={handleDeleteMember}
    />
  );

  return (
    <>
      {section !== 'plugins' && !(isV2 && section === 'members') && <SettingsPageHeader {...pageHeader} />}
      {isV2 && section === 'members' ? (
        <MemberCopyProvider>
          {content}
          {editorOpen && editor}
        </MemberCopyProvider>
      ) : (
        <>
          {content}
          {editorOpen && editor}
        </>
      )}
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
