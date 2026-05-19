'use client';

import { useCallback, useState } from 'react';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import { McpConfigModal, type McpConfigModalProps } from '../McpConfigModal';
import {
  SettingsResourceIconButton,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { PerCatToggles, ProjectSelector, ToggleSwitch } from './capability-settings-ui';
import { SettingsEmptyState, SettingsPrimaryButton, SettingsText } from './primitives';
import { useCapabilityState } from './useCapabilityState';

interface ModalState {
  editId?: string;
  editData?: McpConfigModalProps['editData'];
  readOnly?: boolean;
  tools?: { name: string; description?: string }[];
}

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

function mcpSubInfo(item: CapabilityBoardItem): string | undefined {
  const server = item.mcpServer;
  if (!server) return undefined;
  if (server.transport === 'streamableHttp') return server.url ? `http · ${server.url}` : 'http';
  if (!server.command) return server.resolver ? `resolver · ${server.resolver}` : undefined;
  return `stdio · ${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}`;
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
      editData: buildEditData(item),
    });
  }, []);

  const handleCreate = useCallback(() => setModal({}), []);

  const handleSaved = useCallback(() => {
    setModal(null);
    cap.refetch();
  }, [cap]);

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <SettingsPrimaryButton onClick={handleCreate}>新增 MCP</SettingsPrimaryButton>
      </div>

      <ProjectSelector
        resolvedPath={cap.resolvedProjectPath}
        knownProjects={cap.knownProjects}
        currentSelection={cap.projectPath}
        onSwitch={cap.switchProject}
      />

      {cap.error && (
        <SettingsText as="p" variant="sm" tone="red">
          {cap.error}
        </SettingsText>
      )}

      {cap.loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((index) => (
            <div
              key={index}
              className="animate-pulse h-[68px]"
              style={{
                borderRadius: '0.75rem',
                backgroundColor: 'var(--console-card-bg)',
                padding: '1rem',
              }}
            >
              <div
                className="h-4 w-1/3"
                style={{ borderRadius: '0.25rem', backgroundColor: 'var(--console-border-soft)' }}
              />
              <div
                className="mt-2 h-3 w-2/3"
                style={{ borderRadius: '0.25rem', backgroundColor: 'var(--console-border-soft)' }}
              />
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
          const editable = item.source === 'external';
          const busy = cap.toggling === item.id;
          const removing = cap.disabling === item.id;
          const expanded = expandedId === item.id;
          const subInfo = mcpSubInfo(item);

          return (
            <div key={item.id} className={settingsResourceCardClass}>
              <div className={settingsResourceRowClass}>
                <span style={{ color: 'var(--cafe-text-muted)' }}>
                  <HubIcon name="plug" className="h-[18px] w-[18px] shrink-0" />
                </span>
                <button
                  type="button"
                  onClick={() => handleCardClick(item)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-4"
                  style={{ textAlign: 'left' }}
                >
                  <div className={settingsResourceAvatarClass}>{item.id.charAt(0).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <SettingsText as="p" variant="sm" tone="default" className="font-bold">
                      {item.id}
                    </SettingsText>
                    <SettingsText as="p" tone="secondary" className="mt-0.5 truncate">
                      {item.description || '—'}
                    </SettingsText>
                    {subInfo && (
                      <SettingsText as="p" tone="muted" className="mt-0.5 truncate font-mono">
                        {subInfo}
                      </SettingsText>
                    )}
                  </div>
                </button>
                <div className={settingsResourceActionGroupClass}>
                  <ToggleSwitch
                    enabled={item.enabled}
                    busy={busy}
                    onClick={(event) => {
                      event.stopPropagation();
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
                      onClick={(event) => {
                        event.stopPropagation();
                        if (window.confirm(`确认禁用 MCP "${item.id}"？配置会保留，可稍后重新启用。`)) {
                          cap.handleRemoveMcp(item);
                        }
                      }}
                      title="禁用此 MCP"
                      aria-label="禁用此 MCP"
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
