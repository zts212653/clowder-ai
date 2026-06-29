'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import { McpConfigModal, type McpConfigModalProps } from '../McpConfigModal';
import { SettingsResourceIconButton } from '../SettingsResourceCard';
import { useConfirm } from '../useConfirm';
import { AllProjectsSyncBanner } from './AllProjectsSyncBanner';
import {
  CapabilityRow,
  PerCatToggles,
  PluginManagedLink,
  ProjectSelector,
  ScopeTabs,
  ToggleSwitch,
} from './capability-settings-ui';
import { DriftBanner } from './DriftBanner';
import {
  SettingsBadge,
  SettingsEmptyState,
  SettingsPrimaryButton,
  SettingsSecondaryButton,
  SettingsText,
} from './primitives';
import { useCapabilityState } from './useCapabilityState';
import { useDriftSync } from './useDriftSync';

/** Dual-tab mode: "全部 MCP" (global) or "项目 MCP" (project). */
type McpTab = 'global' | 'project';

interface ModalState {
  editId?: string;
  editData?: McpConfigModalProps['editData'];
  readOnly?: boolean;
  tools?: { name: string; description?: string }[];
}

const MCP_SKELETON_CARD_CLASS =
  'animate-pulse h-[68px] rounded-xl bg-[var(--console-card-bg)] p-4 shadow-[0_8px_22px_rgba(43,33,26,0.04)]';
const MCP_SKELETON_BAR_CLASS = 'rounded bg-[var(--console-border-soft)]';

function buildEditData(item: CapabilityBoardItem): McpConfigModalProps['editData'] {
  const server = item.mcpServer;
  if (!server) return undefined;
  return {
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env: server.env,
    headers: server.headers,
    envKeys: server.envKeys ?? Object.keys(server.env ?? {}),
    resolver: server.resolver,
  };
}

/**
 * F249/#712: Derive overall MCP toggle state from raw data, matching Skills pattern.
 * Global view → globalEnabled (declared policy).
 * Project view → any cat enabled (derived from blockedCats/cats field).
 */
function mcpEffectiveEnabled(item: CapabilityBoardItem, isProject: boolean): boolean {
  return isProject ? Object.values(item.cats ?? {}).some(Boolean) : (item.globalEnabled ?? true);
}

function mcpSubInfo(item: CapabilityBoardItem): string | undefined {
  const server = item.mcpServer;
  if (!server) return undefined;
  if (server.transport === 'streamableHttp') return server.url ? `http · ${server.url}` : 'http';
  if (!server.command) return server.resolver ? `resolver · ${server.resolver}` : undefined;
  return `stdio · ${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}`;
}

export function McpManageContent() {
  const cap = useCapabilityState('mcp');
  const confirm = useConfirm();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<McpTab>('global');
  const [refreshToken, setRefreshToken] = useState(0);

  // F249: Unified drift sync — same hook/endpoint as Skills, type='mcp'.
  const driftSync = useDriftSync({
    type: 'mcp',
    projectPaths: cap.knownProjects,
    resolvedProjectPath: cap.resolvedProjectPath,
    refreshToken,
    // Gate on !loading so drift-check waits for the capability list to settle.
    // Without this, switching tabs fires the drift effect twice: once on
    // enabled change (stale paths), again when knownProjects update.
    enabled: activeTab === 'global' && !cap.loading,
  });

  const handleCardClick = useCallback((item: CapabilityBoardItem) => {
    const readOnly = item.source !== 'external' || !!item.pluginId;
    setModal({
      editId: item.id,
      readOnly,
      // Modal auto-probes on mount (McpConfigModal.handleProbeTools); no parent fetch needed.
      tools: undefined,
      editData: buildEditData(item),
    });
  }, []);

  const handleCreate = useCallback(() => setModal({}), []);

  const handleSaved = useCallback(() => {
    setModal(null);
    cap.refetch();
    setRefreshToken((t) => t + 1);
  }, [cap]);

  const handleDriftResolved = useCallback(() => {
    cap.refetch();
    setRefreshToken((t) => t + 1);
  }, [cap]);

  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<{ count: number; added: string[] } | null>(null);
  const handleDiscover = useCallback(async () => {
    setDiscovering(true);
    setDiscoverResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (cap.projectPath) body.projectPath = cap.projectPath;
      const res = await apiFetch('/api/capabilities/mcp/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        cap.setError(await res.text());
        return;
      }
      const data = (await res.json()) as { ok: boolean; count: number; added: string[] };
      setDiscoverResult({ count: data.count, added: data.added });
      if (data.count > 0) cap.refetch();
    } catch {
      cap.setError('同步失败');
    } finally {
      setDiscovering(false);
    }
  }, [cap]);

  return (
    <div className="space-y-5">
      {/* F249: Dual tab header — shared ScopeTabs with MCP-specific action buttons */}
      <ScopeTabs
        tabs={[
          { key: 'global', label: '全部 MCP', count: cap.items.length },
          { key: 'project', label: '项目 MCP', count: cap.items.length },
        ]}
        activeKey={activeTab}
        ariaLabel="MCP scope"
        onTabChange={(key) => {
          const tab = key as McpTab;
          setActiveTab(tab);
          setDiscoverResult(null);
          if (tab === 'global') {
            // F249 R4: Clear project scope when switching to global tab so
            // handleToggle uses scope='global', not stale project scope.
            cap.switchProject(null);
          } else {
            // F249: Mirror Skills pattern — switch to project scope so the
            // MCP list reflects the selected project's capabilities.json.
            cap.switchProject(cap.projectPath ?? cap.resolvedProjectPath ?? null);
          }
        }}
        actions={
          <>
            <SettingsSecondaryButton onClick={handleDiscover} disabled={discovering}>
              {discovering ? '同步中…' : '同步系统配置'}
            </SettingsSecondaryButton>
            <SettingsPrimaryButton onClick={handleCreate}>新增 MCP</SettingsPrimaryButton>
          </>
        }
      />

      {discoverResult && (
        <SettingsText as="p" variant="sm" tone={discoverResult.count > 0 ? 'green' : 'muted'}>
          {discoverResult.count > 0
            ? `已从系统配置同步 ${discoverResult.count} 个 MCP：${discoverResult.added.join('、')}`
            : '未发现新的系统 MCP 配置'}
        </SettingsText>
      )}

      {/* F249: Unified drift banners — same components as Skills, type='mcp' */}
      {activeTab === 'global' ? (
        <AllProjectsSyncBanner
          type="mcp"
          scopes={driftSync.scopeIssues}
          scopesWithIssues={driftSync.scopesWithIssues}
          syncing={driftSync.syncing}
          error={driftSync.syncAllError}
          onSyncAll={driftSync.handleSyncAllScopes}
          onSyncScope={driftSync.handleSyncScope}
        />
      ) : (
        <>
          <ProjectSelector
            resolvedPath={cap.resolvedProjectPath}
            knownProjects={cap.knownProjects}
            currentSelection={cap.projectPath}
            onSwitch={cap.switchProject}
            alwaysShow
          />
          <DriftBanner
            type="mcp"
            projectPath={cap.projectPath ?? undefined}
            refreshToken={refreshToken}
            onResolved={handleDriftResolved}
          />
        </>
      )}

      {cap.error && (
        <SettingsText as="p" variant="sm" tone="red">
          {cap.error}
        </SettingsText>
      )}

      {cap.loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((index) => (
            <div key={index} className={MCP_SKELETON_CARD_CLASS}>
              <div className={`${MCP_SKELETON_BAR_CLASS} h-4 w-1/3`} />
              <div className={`${MCP_SKELETON_BAR_CLASS} mt-2 h-3 w-2/3`} />
            </div>
          ))}
        </div>
      )}

      {!cap.loading && cap.items.length === 0 && (
        <SettingsEmptyState
          icon={
            <span className="mb-3" style={{ color: 'var(--cafe-text-muted)' }}>
              <HubIcon name="box" className="h-10 w-10 opacity-40" />
            </span>
          }
          title="暂无已安装的 MCP"
          description="点击上方按钮手动新增 MCP 配置"
        />
      )}

      <div className="space-y-2">
        {cap.items.map((item) => {
          const pluginId = item.pluginId;
          const pluginManaged = !!pluginId;
          const editable = item.source === 'external' && !pluginManaged;
          const busy = cap.toggling === item.id;
          const removing = cap.disabling === item.id;
          const expanded = expandedId === item.id;
          const effectiveEnabled = mcpEffectiveEnabled(item, activeTab === 'project');

          return (
            <CapabilityRow
              key={item.id}
              name={item.id}
              description={item.description}
              subInfo={mcpSubInfo(item)}
              subInfoMono
              onClick={() => handleCardClick(item)}
              badges={
                <>
                  {pluginManaged && (
                    <SettingsBadge
                      tone="blue"
                      size="xxs"
                      className="inline-block max-w-[9rem] truncate align-middle sm:max-w-[12rem]"
                    >
                      由插件 {pluginId} 管理
                    </SettingsBadge>
                  )}
                  {item.discoveredFrom && (
                    <SettingsBadge tone="slate" size="xxs" className="inline-block align-middle">
                      来自 {item.discoveredFrom}
                    </SettingsBadge>
                  )}
                </>
              }
              actions={
                <>
                  <ToggleSwitch
                    enabled={effectiveEnabled}
                    busy={busy}
                    disabled={pluginManaged}
                    title={pluginManaged ? `由插件 ${pluginId} 管理` : effectiveEnabled ? '禁用' : '启用'}
                    onClick={(event) => {
                      event.stopPropagation();
                      cap.handleToggle(item, !effectiveEnabled);
                    }}
                  />
                  {pluginId && <PluginManagedLink pluginId={pluginId} />}
                  {!pluginManaged && cap.catFamilies.length > 0 && (
                    <SettingsResourceIconButton
                      onClick={() => setExpandedId(expanded ? null : item.id)}
                      title="按猫开关"
                      aria-label="按猫开关"
                      className={expanded ? 'bg-[var(--console-hover-bg)] text-cafe-accent' : undefined}
                    >
                      <HubIcon name="users" className="h-4 w-4" />
                    </SettingsResourceIconButton>
                  )}
                  {editable && (
                    <SettingsResourceIconButton
                      disabled={removing}
                      onClick={async (event) => {
                        event.stopPropagation();
                        const ok = await confirm({
                          title: '卸载 MCP',
                          message: `确认卸载 MCP "${item.id}"？配置将被移除，不可撤销。`,
                          confirmLabel: '卸载',
                          variant: 'danger',
                        });
                        if (ok) cap.handleRemoveMcp(item);
                      }}
                      title="卸载此 MCP"
                      aria-label="卸载此 MCP"
                      tone="danger"
                    >
                      <HubIcon name="trash" className="h-4 w-4" />
                    </SettingsResourceIconButton>
                  )}
                </>
              }
              expandedContent={
                expanded && !pluginManaged ? (
                  <PerCatToggles
                    item={item}
                    catFamilies={cap.catFamilies}
                    toggling={cap.toggling}
                    onToggle={cap.handleToggle}
                  />
                ) : undefined
              }
            />
          );
        })}
      </div>

      {modal && (
        <McpConfigModal
          projectPath={cap.projectPath ?? undefined}
          editId={modal.editId}
          editData={modal.editData}
          readOnly={modal.readOnly}
          tools={modal.tools}
          onSaved={handleSaved}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
