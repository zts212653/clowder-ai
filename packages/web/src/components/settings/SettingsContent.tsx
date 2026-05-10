'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { CatOverviewTab, type ConfigData } from '../config-viewer-tabs';
import { HubAccountsTab } from '../HubAccountsTab';
import { HubCatEditor } from '../HubCatEditor';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { HubConnectorConfigTab } from '../HubConnectorConfigTab';
import { HubEnvFilesTab } from '../HubEnvFilesTab';
import { PushSettingsPanel } from '../PushSettingsPanel';
import { useConfirm } from '../useConfirm';
import { VoiceSettingsPanel } from '../VoiceSettingsPanel';
import { MarketplaceContent } from './MarketplaceContent';
import { McpManageContent } from './McpManageContent';
import { OpsContent } from './OpsContent';
import { PluginsContent } from './PluginsContent';
import { RulesPromptsContent } from './RulesPromptsContent';
import { ServiceStatusPanel } from './ServiceStatusPanel';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SettingsPlaceholder } from './SettingsPlaceholder';
import { SkillsContent } from './SkillsContent';
import { SETTINGS_SECTIONS } from './settings-nav-config';

interface SettingsContentProps {
  section: string;
}

export function SettingsContent({ section }: SettingsContentProps) {
  const { cats, refresh } = useCatData();
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [createDraft, setCreateDraft] = useState<Parameters<typeof HubCatEditor>[0]['draft']>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const confirm = useConfirm();

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
    fetchData();
  }, [fetchData]);

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

  const meta = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];

  if (section === 'im') return <HubConnectorConfigTab />;
  if (section === 'skills') return <SkillsContent />;
  if (section === 'mcp') return <McpManageContent />;
  if (section === 'marketplace') return <MarketplaceContent />;

  const sectionContent = (() => {
    switch (section) {
      case 'members':
        if (fetchError) return <p className="text-sm text-[var(--semantic-error-text)]">{fetchError}</p>;
        return config ? (
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
          <p className="text-sm text-cafe-muted">加载中...</p>
        );
      case 'accounts':
        return <HubAccountsTab />;
      case 'plugins':
        return <PluginsContent />;
      case 'voice':
        return (
          <div className="space-y-6">
            <ServiceStatusPanel
              filterFeatures={['voice-input', 'voice-output', 'voice-companion', 'voice-postprocess']}
              title="语音服务"
            />
            <VoiceSettingsPanel />
          </div>
        );
      case 'system':
        if (fetchError) return <p className="text-sm text-[var(--semantic-error-text)]">{fetchError}</p>;
        return <HubEnvFilesTab excludeCategories={['connector']} />;
      case 'rules':
        return <RulesPromptsContent />;
      case 'notify':
        return <PushSettingsPanel />;
      case 'ops':
        return <OpsContent />;
      default:
        return <SettingsPlaceholder section={section} description="此分区即将上线" />;
    }
  })();

  return (
    <>
      <SettingsPageHeader title={meta.label} subtitle={meta.description} />
      {sectionContent}
      {editorOpen && (
        <HubCatEditor
          open
          cat={editingCat}
          draft={createDraft}
          onClose={() => {
            setEditorOpen(false);
            setEditingCat(null);
            setCreateDraft(null);
          }}
          onSaved={handleEditorSaved}
        />
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
