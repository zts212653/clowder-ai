'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '../utils/api-client';
import { StepBadge } from './HubConfigIcons';
import { SettingsResourceToggleSwitch } from './SettingsResourceCard';

interface GroupEntry {
  externalChatId: string;
  label?: string;
  addedAt: number;
}

interface PermissionConfig {
  whitelistEnabled: boolean;
  commandAdminOnly: boolean;
  adminOpenIds: string[];
  allowedGroups: GroupEntry[];
}

const EMPTY_CONFIG: PermissionConfig = {
  whitelistEnabled: false,
  commandAdminOnly: false,
  adminOpenIds: [],
  allowedGroups: [],
};

export interface HubPermissionsTabHandle {
  getConfig(): PermissionConfig;
  applyConfig(c: PermissionConfig): void;
}

interface HubPermissionsTabProps {
  connectorId: string;
}

const HubPermissionsTab = forwardRef<HubPermissionsTabHandle, HubPermissionsTabProps>(function HubPermissionsTab(
  { connectorId },
  ref,
) {
  const [config, setConfig] = useState<PermissionConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupLabel, setNewGroupLabel] = useState('');
  const [newAdminId, setNewAdminId] = useState('');
  const ime = useIMEGuard();

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/connector/permissions/${connectorId}`);
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      }
    } catch {
      // Permission store may not be available
    } finally {
      setLoading(false);
    }
  }, [connectorId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useImperativeHandle(
    ref,
    () => ({
      getConfig() {
        return config;
      },
      applyConfig(c: PermissionConfig) {
        setConfig(c);
      },
    }),
    [config],
  );

  const addGroup = () => {
    if (!newGroupId.trim()) return;
    setConfig((prev) => ({
      ...prev,
      allowedGroups: [
        ...prev.allowedGroups,
        { externalChatId: newGroupId.trim(), label: newGroupLabel.trim() || undefined, addedAt: Date.now() },
      ],
    }));
    setNewGroupId('');
    setNewGroupLabel('');
  };

  const removeGroup = (chatId: string) => {
    setConfig((prev) => ({
      ...prev,
      allowedGroups: prev.allowedGroups.filter((g) => g.externalChatId !== chatId),
    }));
  };

  const addAdmin = () => {
    if (!newAdminId.trim()) return;
    setConfig((prev) => ({
      ...prev,
      adminOpenIds: [...prev.adminOpenIds, newAdminId.trim()],
    }));
    setNewAdminId('');
  };

  const removeAdmin = (openId: string) => {
    setConfig((prev) => ({
      ...prev,
      adminOpenIds: prev.adminOpenIds.filter((id) => id !== openId),
    }));
  };

  if (loading) return <div className="p-6 text-cafe-muted text-sm">加载权限配置...</div>;

  return (
    <div className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
      <div className="bg-conn-emerald-bg px-4 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-conn-emerald-ring flex items-center justify-center text-conn-emerald-text">
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
            />
          </svg>
        </div>
        <div>
          <div className="font-semibold text-sm">群聊权限管理</div>
          <div className="text-xs text-cafe-secondary">控制谁能用 bot、谁能用管理命令</div>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {/* Section 1: Group Whitelist */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <StepBadge num={1} />
              <span className="text-xs font-medium text-cafe-secondary">群白名单</span>
            </div>
            <SettingsResourceToggleSwitch
              enabled={config.whitelistEnabled}
              onClick={() => setConfig((prev) => ({ ...prev, whitelistEnabled: !prev.whitelistEnabled }))}
            />
          </div>
          <p className="ml-[26px] text-xs text-cafe-secondary">开启后，仅白名单内的群可使用 bot</p>
          {config.whitelistEnabled && (
            <div className="ml-[26px] space-y-1.5">
              {config.allowedGroups.map((g) => (
                <div
                  key={g.externalChatId}
                  className="flex items-center gap-2 px-3 py-2 bg-[var(--console-card-bg)] rounded-lg text-xs"
                >
                  <svg
                    className="w-3.5 h-3.5 text-[var(--color-cafe-accent)]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"
                    />
                  </svg>
                  <span className="flex-1 truncate text-cafe-secondary dark:text-cafe-muted">
                    {g.label || g.externalChatId}{' '}
                    {g.label ? <span className="text-cafe-muted">{g.externalChatId.slice(-8)}</span> : null}
                  </span>
                  <button onClick={() => removeGroup(g.externalChatId)} className="text-conn-red-text hover:opacity-90">
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  value={newGroupId}
                  onChange={(e) => setNewGroupId(e.target.value)}
                  placeholder="chat_id"
                  className="console-form-input flex-1 min-w-0 py-2.5 text-[13px]"
                />
                <input
                  value={newGroupLabel}
                  onChange={(e) => setNewGroupLabel(e.target.value)}
                  placeholder="群名（可选）"
                  className="console-form-input flex-1 min-w-0 py-2.5 text-[13px]"
                />
                <button
                  onClick={addGroup}
                  disabled={!newGroupId.trim()}
                  className="shrink-0 px-3 py-1.5 text-xs bg-[var(--color-cafe-accent)] text-[var(--cafe-surface)] rounded-lg disabled:opacity-40"
                >
                  添加
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Section 2: Admin List */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <StepBadge num={2} />
            <span className="text-xs font-medium text-cafe-secondary">管理员</span>
          </div>
          <p className="ml-[26px] text-xs text-cafe-secondary">
            管理员可使用 /allow-group、/deny-group、/new、/use 等管理命令
          </p>
          <div className="ml-[26px] space-y-1.5">
            {config.adminOpenIds.map((id, i) => (
              <div
                key={id}
                className="flex items-center gap-2 px-3 py-2 bg-[var(--console-card-bg)] rounded-lg text-xs"
              >
                <svg
                  className="w-3.5 h-3.5 text-conn-amber-text"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 1a.75.75 0 0 1 .65.378l2.005 3.518 3.907.896a.75.75 0 0 1 .35 1.238l-2.634 2.87.363 3.964a.75.75 0 0 1-1.054.747L10 12.868l-3.587 1.743a.75.75 0 0 1-1.054-.747l.363-3.964L3.088 7.03a.75.75 0 0 1 .35-1.238l3.907-.896L9.35 1.378A.75.75 0 0 1 10 1Z"
                    clipRule="evenodd"
                  />
                </svg>
                <span className="flex-1 truncate text-cafe-secondary dark:text-cafe-muted">{id}</span>
                {i === 0 && (
                  <span className="px-1.5 py-0.5 bg-conn-amber-bg text-conn-amber-text rounded text-[10px] font-semibold">
                    Owner
                  </span>
                )}
                <button onClick={() => removeAdmin(id)} className="text-conn-red-text hover:opacity-90">
                  ✕
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                value={newAdminId}
                onChange={(e) => setNewAdminId(e.target.value)}
                placeholder="open_id (ou_xxxx...)"
                className="console-form-input flex-1 min-w-0 py-2.5 text-[13px]"
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => e.key === 'Enter' && !ime.isComposing() && addAdmin()}
              />
              <button
                onClick={addAdmin}
                disabled={!newAdminId.trim()}
                className="shrink-0 px-3 py-1.5 text-xs bg-[var(--color-cafe-accent)] text-[var(--cafe-surface)] rounded-lg disabled:opacity-40"
              >
                添加
              </button>
            </div>
          </div>
        </div>

        {/* Section 3: Command Admin Only */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <StepBadge num={3} />
              <span className="text-xs font-medium text-cafe-secondary">群聊命令仅管理员</span>
            </div>
            <SettingsResourceToggleSwitch
              enabled={config.commandAdminOnly}
              onClick={() => setConfig((prev) => ({ ...prev, commandAdminOnly: !prev.commandAdminOnly }))}
            />
          </div>
          <p className="ml-[26px] text-xs text-cafe-secondary">
            开启后，非管理员在群聊发 /threads /new /use 会收到提示
          </p>
          {config.commandAdminOnly && (
            <div className="ml-[26px] flex items-center gap-2 px-3 py-2 bg-conn-red-bg rounded-lg text-xs text-conn-red-text">
              <svg
                className="w-3.5 h-3.5 text-conn-red-text shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
              <span>非管理员会看到：&quot;此命令仅管理员可用&quot;</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default HubPermissionsTab;
