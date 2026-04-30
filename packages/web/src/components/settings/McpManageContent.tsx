'use client';

import { useCallback, useState } from 'react';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import { McpConfigModal, type McpConfigModalProps } from '../McpConfigModal';
import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { PerCatToggles, ProjectSelector, ToggleSwitch } from './capability-settings-ui';
import { useCapabilityState } from './useCapabilityState';

interface ModalState {
  editId?: string;
  editData?: McpConfigModalProps['editData'];
}

export function McpManageContent() {
  const cap = useCapabilityState('mcp');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleCardClick = useCallback((item: CapabilityBoardItem) => {
    if (item.source !== 'external') return;
    setModal({
      editId: item.id,
      editData: item.mcpServer
        ? {
            transport: item.mcpServer.transport,
            command: item.mcpServer.command,
            args: item.mcpServer.args,
            url: item.mcpServer.url,
            env: item.mcpServer.env,
            headers: item.mcpServer.headers,
            envKeys: item.mcpServer.envKeys,
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
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <div className="mb-5 flex items-center justify-between">
          <ProjectSelector
            resolvedPath={cap.resolvedProjectPath}
            knownProjects={cap.knownProjects}
            currentSelection={cap.projectPath}
            onSwitch={cap.switchProject}
          />
          <button
            type="button"
            onClick={handleCreate}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--cafe-accent,#C65F3D)] px-3.5 py-2 text-[13px] font-semibold text-[var(--cafe-surface)] hover:opacity-90 transition-opacity"
          >
            <HubIcon name="plus" className="h-3.5 w-3.5" />
            新增 MCP
          </button>
        </div>

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
                ? item.mcpServer.url
                : item.mcpServer?.command
                  ? `${item.mcpServer.command}${item.mcpServer.args?.length ? ` ${item.mcpServer.args.join(' ')}` : ''}`
                  : undefined;
            return (
              <div
                key={item.id}
                className="rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)]"
              >
                <div className="flex items-center gap-4">
                  <svg className="h-[18px] w-[18px] shrink-0 text-cafe-muted" viewBox="0 0 24 24" fill="currentColor">
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
                    disabled={!editable}
                    className={`flex min-w-0 flex-1 items-center gap-4 text-left ${editable ? 'cursor-pointer' : 'cursor-default'}`}
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--console-active-bg)] text-sm font-bold text-cafe-interactive">
                      {item.id.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-extrabold text-cafe">{item.id}</p>
                      <p className="mt-0.5 truncate text-xs text-cafe-secondary">{item.description || '—'}</p>
                      {subInfo && <p className="mt-0.5 truncate text-[11px] font-mono text-cafe-muted">{subInfo}</p>}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {editable && (
                      <button
                        type="button"
                        disabled={removing}
                        onClick={(e) => {
                          e.stopPropagation();
                          cap.handleDisableMcp(item);
                        }}
                        className={`rounded-md p-1.5 text-cafe-muted hover:bg-[var(--console-card-soft-bg)] hover:text-[var(--console-stop,#f26767)] transition-colors ${removing ? 'opacity-50' : ''}`}
                        title="禁用此 MCP"
                      >
                        <HubIcon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {cap.catFamilies.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        className="rounded-md p-1.5 text-cafe-muted hover:bg-[var(--console-card-soft-bg)] hover:text-cafe-secondary transition-colors"
                        title="按猫开关"
                      >
                        <HubIcon name="users" className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <ToggleSwitch
                      enabled={item.enabled}
                      busy={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        cap.handleToggle(item, !item.enabled);
                      }}
                    />
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

      <aside className="hidden w-[280px] shrink-0 lg:block">
        <div className="sticky top-0 rounded-2xl bg-[var(--console-card-bg)] p-4 shadow-[0_8px_24px_rgba(43,33,26,0.05)]">
          <h3 className="text-sm font-bold text-cafe">MCP 市场</h3>
          <p className="mt-1 mb-4 text-xs text-cafe-secondary">
            查询可用 MCP；支持一键安装，失败时自动 fallback 到手动配置。市场永远在右侧 rail。
          </p>
          <MarketplacePanel />
        </div>
      </aside>

      {modal && (
        <McpConfigModal
          projectPath={cap.projectPath ?? undefined}
          editId={modal.editId}
          editData={modal.editData}
          onSaved={handleSaved}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
