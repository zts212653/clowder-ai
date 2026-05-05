'use client';

import { useCallback, useState } from 'react';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import { McpConfigModal, type McpConfigModalProps } from '../McpConfigModal';
import { MarketplacePanel } from '../marketplace/marketplace-panel';
import {
  SettingsResourceIconButton,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { PerCatToggles, ProjectSelector, ToggleSwitch } from './capability-settings-ui';
import { SettingsPageHeader } from './SettingsPageHeader';
import { useCapabilityState } from './useCapabilityState';

interface ModalState {
  editId?: string;
  editData?: McpConfigModalProps['editData'];
  readOnly?: boolean;
  tools?: { name: string; description?: string }[];
}

export function McpManageContent() {
  const cap = useCapabilityState('mcp');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleCardClick = useCallback((item: CapabilityBoardItem) => {
    const readOnly = item.source !== 'external';
    setModal({
      editId: item.id,
      readOnly,
      tools: item.tools,
      editData: item.mcpServer
        ? {
            transport: item.mcpServer.transport,
            command: readOnly ? item.mcpServer.command : undefined,
            args: readOnly ? item.mcpServer.args : undefined,
            url: readOnly ? item.mcpServer.url : undefined,
            env: item.mcpServer.env,
            headers: item.mcpServer.headers,
            envKeys: item.mcpServer.envKeys,
            resolver: item.mcpServer.resolver,
          }
        : undefined,
    });
  }, []);

  const handleCreate = useCallback(() => setModal({}), []);

  const handleSaved = useCallback(() => {
    setModal(null);
    cap.refetch();
  }, [cap]);

  return (
    <div className="flex gap-5">
      <div className="min-w-0 flex-1 space-y-5">
        <SettingsPageHeader title="MCP 管理" subtitle="点击卡片预览/编辑">
          <button
            type="button"
            onClick={handleCreate}
            className="flex shrink-0 items-center justify-center rounded-[10px] bg-[var(--cafe-accent,#C65F3D)] px-3.5 h-[34px] text-[13px] font-bold text-[var(--cafe-surface)] hover:opacity-90 transition-opacity"
          >
            新增 MCP
          </button>
        </SettingsPageHeader>

        <ProjectSelector
          resolvedPath={cap.resolvedProjectPath}
          knownProjects={cap.knownProjects}
          currentSelection={cap.projectPath}
          onSwitch={cap.switchProject}
        />

        {cap.loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse rounded-xl bg-[var(--console-card-bg)] p-4">
                <div className="h-4 w-1/3 rounded bg-[var(--console-border-soft)]" />
                <div className="mt-2 h-3 w-2/3 rounded bg-[var(--console-border-soft)]" />
              </div>
            ))}
          </div>
        )}

        {!cap.loading && cap.items.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--console-card-bg)] px-8 py-16 text-center">
            <HubIcon name="box" className="mb-3 h-10 w-10 text-cafe-muted opacity-40" />
            <p className="text-[15px] font-semibold text-cafe">暂无已安装的 MCP</p>
            <p className="mt-1 text-xs text-cafe-muted">从右侧市场搜索并安装，或点击上方按钮手动新增</p>
          </div>
        )}

        <div className="space-y-3">
          {cap.items.map((item) => {
            const editable = item.source === 'external';
            const busy = cap.toggling === item.id;
            const removing = cap.disabling === item.id;
            const expanded = expandedId === item.id;
            const subInfo =
              item.mcpServer?.transport === 'streamableHttp'
                ? `http · ${item.mcpServer.url}`
                : item.mcpServer?.command
                  ? `stdio · ${item.mcpServer.command}${item.mcpServer.args?.length ? ` ${item.mcpServer.args.join(' ')}` : ''}`
                  : undefined;
            return (
              <div key={item.id} className={settingsResourceCardClass}>
                <div className={settingsResourceRowClass}>
                  <svg
                    className="h-[18px] w-[18px] shrink-0 text-cafe-muted"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="9" cy="5" r="1.5" />
                    <circle cx="15" cy="5" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                    <circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="19" r="1.5" />
                    <circle cx="15" cy="19" r="1.5" />
                  </svg>
                  <button
                    type="button"
                    onClick={() => handleCardClick(item)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 text-left"
                  >
                    <div className={settingsResourceAvatarClass}>{item.id.charAt(0).toUpperCase()}</div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-extrabold text-cafe">{item.id}</p>
                      <p className="mt-0.5 truncate text-xs text-cafe-secondary">{item.description || '—'}</p>
                      {subInfo && <p className="mt-0.5 truncate text-[11px] font-mono text-cafe-muted">{subInfo}</p>}
                    </div>
                  </button>
                  <div className={settingsResourceActionGroupClass}>
                    <ToggleSwitch
                      enabled={item.enabled}
                      busy={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        cap.handleToggle(item, !item.enabled);
                      }}
                    />
                    {cap.catFamilies.length > 0 && (
                      <SettingsResourceIconButton
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        title="按猫开关"
                        aria-label="按猫开关"
                      >
                        <HubIcon name="users" className="h-4 w-4" />
                      </SettingsResourceIconButton>
                    )}
                    {editable && (
                      <SettingsResourceIconButton
                        disabled={removing}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`确认卸载 MCP "${item.id}"？卸载后需重新安装。`)) {
                            cap.handleRemoveMcp(item);
                          }
                        }}
                        title="卸载此 MCP"
                        aria-label="卸载此 MCP"
                        tone="danger"
                      >
                        <HubIcon name="trash" className="h-4 w-4" />
                      </SettingsResourceIconButton>
                    )}
                  </div>
                </div>
                {expanded && (
                  <PerCatToggles
                    item={item}
                    catFamilies={cap.catFamilies}
                    toggling={cap.toggling}
                    onToggle={cap.handleToggle}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <aside className="hidden w-[320px] shrink-0 lg:block">
        <div className="sticky top-0 rounded-2xl bg-[var(--console-card-bg)] p-4 shadow-[0_8px_24px_rgba(43,33,26,0.05)]">
          <h3 className="text-sm font-bold text-cafe">MCP 市场</h3>
          <p className="mt-1 mb-4 text-xs text-cafe-secondary">查询可用 MCP；安装后进入左侧列表。</p>
          <MarketplacePanel
            artifactKinds={['mcp_server']}
            projectPath={cap.projectPath ?? undefined}
            onInstalled={cap.refetch}
          />
        </div>
      </aside>

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
