'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api-client';

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

export default function HubPermissionsTab() {
  const [config, setConfig] = useState<PermissionConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<'ok' | 'error' | null>(null);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupLabel, setNewGroupLabel] = useState('');
  const [newAdminId, setNewAdminId] = useState('');

  const fetchConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connector/permissions/feishu');
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      }
    } catch {
      // Permission store may not be available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const saveConfig = async (patch: Partial<PermissionConfig>) => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch('/api/connector/permissions/feishu', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        setSaveResult('ok');
      } else {
        setSaveResult('error');
      }
    } catch {
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 2000);
    }
  };

  const addGroup = () => {
    if (!newGroupId.trim()) return;
    const updated = [
      ...config.allowedGroups,
      { externalChatId: newGroupId.trim(), label: newGroupLabel.trim() || undefined, addedAt: Date.now() },
    ];
    saveConfig({ allowedGroups: updated });
    setNewGroupId('');
    setNewGroupLabel('');
  };

  const removeGroup = (chatId: string) => {
    const updated = config.allowedGroups.filter((g) => g.externalChatId !== chatId);
    saveConfig({ allowedGroups: updated });
  };

  const addAdmin = () => {
    if (!newAdminId.trim()) return;
    const updated = [...config.adminOpenIds, newAdminId.trim()];
    saveConfig({ adminOpenIds: updated });
    setNewAdminId('');
  };

  const removeAdmin = (openId: string) => {
    const updated = config.adminOpenIds.filter((id) => id !== openId);
    saveConfig({ adminOpenIds: updated });
  };

  if (loading) return <div className="p-6 text-gray-400 text-sm">加载权限配置...</div>;

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-400 flex items-center gap-1">
        <span className="text-blue-500 cursor-pointer">飞书 Feishu</span>
        <span>›</span>
        <span>群聊权限</span>
      </div>

      <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        {/* Header */}
        <div className="bg-green-50 dark:bg-green-900/20 px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-green-200 dark:bg-green-800 flex items-center justify-center text-green-600 dark:text-green-400">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
              />
            </svg>
          </div>
          <div>
            <div className="font-semibold text-sm">群聊权限管理</div>
            <div className="text-xs text-gray-500">控制谁能用 bot、谁能用管理命令</div>
          </div>
        </div>

        <div className="p-4 space-y-5">
          {/* Section 1: Group Whitelist */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-[18px] h-[18px] rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                  1
                </span>
                <span className="font-semibold text-sm">群白名单</span>
              </div>
              <button
                onClick={() => saveConfig({ whitelistEnabled: !config.whitelistEnabled })}
                className={`relative w-10 h-5 rounded-full transition-colors ${config.whitelistEnabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                disabled={saving}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${config.whitelistEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-500">开启后，仅白名单内的群可使用 bot</p>

            {config.whitelistEnabled && (
              <div className="space-y-1.5">
                {config.allowedGroups.map((g) => (
                  <div
                    key={g.externalChatId}
                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-xs"
                  >
                    <svg
                      className="w-3.5 h-3.5 text-blue-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"
                      />
                    </svg>
                    <span className="flex-1 truncate text-gray-700 dark:text-gray-300">
                      {g.label || g.externalChatId}{' '}
                      {g.label ? <span className="text-gray-400">{g.externalChatId.slice(-8)}</span> : null}
                    </span>
                    <button onClick={() => removeGroup(g.externalChatId)} className="text-red-400 hover:text-red-600">
                      ✕
                    </button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    value={newGroupId}
                    onChange={(e) => setNewGroupId(e.target.value)}
                    placeholder="chat_id"
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent"
                  />
                  <input
                    value={newGroupLabel}
                    onChange={(e) => setNewGroupLabel(e.target.value)}
                    placeholder="群名（可选）"
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent"
                  />
                  <button
                    onClick={addGroup}
                    disabled={!newGroupId.trim()}
                    className="px-3 py-1.5 text-xs bg-blue-500 text-white rounded-lg disabled:opacity-40"
                  >
                    添加
                  </button>
                </div>
              </div>
            )}
          </div>

          <hr className="border-gray-100 dark:border-gray-800" />

          {/* Section 2: Admin List */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-[18px] h-[18px] rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                2
              </span>
              <span className="font-semibold text-sm">管理员</span>
            </div>
            <p className="text-xs text-gray-500">管理员可使用 /allow-group、/deny-group、/new、/use 等管理命令</p>

            <div className="space-y-1.5">
              {config.adminOpenIds.map((id, i) => (
                <div
                  key={id}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-xs"
                >
                  <svg className="w-3.5 h-3.5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 1a.75.75 0 0 1 .65.378l2.005 3.518 3.907.896a.75.75 0 0 1 .35 1.238l-2.634 2.87.363 3.964a.75.75 0 0 1-1.054.747L10 12.868l-3.587 1.743a.75.75 0 0 1-1.054-.747l.363-3.964L3.088 7.03a.75.75 0 0 1 .35-1.238l3.907-.896L9.35 1.378A.75.75 0 0 1 10 1Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{id}</span>
                  {i === 0 && (
                    <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-semibold">
                      Owner
                    </span>
                  )}
                  <button onClick={() => removeAdmin(id)} className="text-red-400 hover:text-red-600">
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  value={newAdminId}
                  onChange={(e) => setNewAdminId(e.target.value)}
                  placeholder="open_id (ou_xxxx...)"
                  className="flex-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent"
                  onKeyDown={(e) => e.key === 'Enter' && addAdmin()}
                />
                <button
                  onClick={addAdmin}
                  disabled={!newAdminId.trim()}
                  className="px-3 py-1.5 text-xs bg-blue-500 text-white rounded-lg disabled:opacity-40"
                >
                  添加
                </button>
              </div>
            </div>
          </div>

          <hr className="border-gray-100 dark:border-gray-800" />

          {/* Section 3: Command Admin Only */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-[18px] h-[18px] rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                  3
                </span>
                <span className="font-semibold text-sm">群聊命令仅管理员</span>
              </div>
              <button
                onClick={() => saveConfig({ commandAdminOnly: !config.commandAdminOnly })}
                className={`relative w-10 h-5 rounded-full transition-colors ${config.commandAdminOnly ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                disabled={saving}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${config.commandAdminOnly ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-500">开启后，非管理员在群聊发 /threads /new /use 会收到提示</p>
            {config.commandAdminOnly && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs text-red-700 dark:text-red-400">
                <svg
                  className="w-3.5 h-3.5 text-red-500 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
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

      {/* Save feedback */}
      {saveResult === 'ok' && (
        <div className="text-xs text-green-600 flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          已保存
        </div>
      )}
      {saveResult === 'error' && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          保存失败
        </div>
      )}
      {saving && <div className="text-xs text-gray-400">保存中...</div>}
    </div>
  );
}
