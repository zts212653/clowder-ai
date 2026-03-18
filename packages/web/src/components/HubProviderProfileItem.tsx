import { useCallback, useState } from 'react';
import type { ProfileItem, ProfileTestResult } from './hub-provider-profiles.types';

function parseModels(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface ProfileEditPayload {
  displayName: string;
  baseUrl?: string;
  apiKey?: string;
  modelOverride?: string | null;
  models?: string[];
}

interface HubProviderProfileItemProps {
  profile: ProfileItem;
  isActive: boolean;
  busy: boolean;
  testResult?: ProfileTestResult;
  onActivate: (profileId: string) => void;
  onSave: (profileId: string, payload: ProfileEditPayload) => Promise<void>;
  onTest: (profileId: string) => void;
  onDelete: (profileId: string) => void;
}

export function HubProviderProfileItem({
  profile,
  isActive,
  busy,
  testResult,
  onActivate,
  onSave,
  onTest,
  onDelete,
}: HubProviderProfileItemProps) {
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState(profile.displayName);
  const [editBaseUrl, setEditBaseUrl] = useState(profile.baseUrl ?? '');
  const [editApiKey, setEditApiKey] = useState('');
  const [editModels, setEditModels] = useState(profile.models.join(', '));
  const [editModelOverride, setEditModelOverride] = useState(profile.modelOverride ?? '');

  const startEdit = useCallback(() => {
    setEditDisplayName(profile.displayName);
    setEditBaseUrl(profile.baseUrl ?? '');
    setEditApiKey('');
    setEditModels(profile.models.join(', '));
    setEditModelOverride(profile.modelOverride ?? '');
    setEditing(true);
  }, [profile]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const saveEdit = useCallback(async () => {
    await onSave(profile.id, {
      displayName: editDisplayName.trim(),
      ...(profile.authType === 'api_key' && editBaseUrl.trim() ? { baseUrl: editBaseUrl.trim() } : {}),
      ...(editApiKey.trim() ? { apiKey: editApiKey.trim() } : {}),
      ...(editModels.trim() ? { models: parseModels(editModels) } : {}),
      modelOverride: editModelOverride.trim() || null,
    });
    setEditing(false);
  }, [onSave, profile.id, profile.authType, editDisplayName, editBaseUrl, editApiKey, editModels, editModelOverride]);

  const inputCls = 'px-2 py-1 rounded border border-gray-200 bg-white text-xs w-full';
  const showTestButton = profile.protocol === 'anthropic' && profile.authType === 'api_key';

  if (editing) {
    return (
      <div className="rounded-lg border-2 border-blue-300 bg-blue-50/30 p-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input
            value={editDisplayName}
            onChange={(e) => setEditDisplayName(e.target.value)}
            placeholder="账号显示名"
            className={inputCls}
          />
          <div className="px-2 py-1 rounded border border-gray-200 bg-gray-50 text-xs text-gray-600">
            {profile.protocol} · {profile.authType}
            {profile.builtin ? ' · builtin' : ''}
          </div>
          {profile.authType === 'api_key' && (
            <>
              <input
                value={editBaseUrl}
                onChange={(e) => setEditBaseUrl(e.target.value)}
                placeholder="Base URL"
                className={`${inputCls} md:col-span-2`}
              />
              <input
                value={editApiKey}
                onChange={(e) => setEditApiKey(e.target.value)}
                placeholder={profile.hasApiKey ? 'API Key（留空保持不变）' : 'API Key'}
                className={`${inputCls} md:col-span-2`}
              />
            </>
          )}
          <input
            value={editModels}
            onChange={(e) => setEditModels(e.target.value)}
            placeholder="支持模型（逗号分隔）"
            className={`${inputCls} md:col-span-2`}
          />
          <input
            value={editModelOverride}
            onChange={(e) => setEditModelOverride(e.target.value)}
            placeholder="默认/覆盖模型（可选）"
            className={`${inputCls} md:col-span-2`}
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={saveEdit}
            disabled={busy}
            className="px-3 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? '保存中...' : '保存'}
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            disabled={busy}
            className="px-3 py-1 rounded border border-gray-200 text-gray-600 text-xs hover:bg-gray-50"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-800">{profile.displayName}</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{profile.authType}</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{profile.protocol}</span>
            {profile.builtin && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">🔒 内置</span>}
            {isActive && <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">active</span>}
          </div>
          <p className="text-xs text-gray-500">
            {profile.authType === 'api_key'
              ? `baseUrl: ${profile.baseUrl ?? '(未设置)'} · apiKey: ${profile.hasApiKey ? '已配置' : '未配置'}`
              : '走本机 OAuth / CLI 登录态，不使用 API key'}
          </p>
          {profile.models.length > 0 && <p className="text-xs text-indigo-600">models: {profile.models.join(', ')}</p>}
          {profile.modelOverride && <p className="text-xs text-indigo-500">default: {profile.modelOverride}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {!isActive && (
            <button
              type="button"
              className="px-2 py-1 rounded border border-blue-200 text-blue-700 text-xs hover:bg-blue-50"
              onClick={() => onActivate(profile.id)}
              disabled={busy}
            >
              激活
            </button>
          )}
          <button
            type="button"
            className="px-2 py-1 rounded border border-gray-200 text-gray-700 text-xs hover:bg-gray-50"
            onClick={startEdit}
            disabled={busy}
          >
            编辑
          </button>
          {showTestButton && (
            <button
              type="button"
              className="px-2 py-1 rounded border border-indigo-200 text-indigo-700 text-xs hover:bg-indigo-50"
              onClick={() => onTest(profile.id)}
              disabled={busy}
            >
              测试
            </button>
          )}
          {!profile.builtin && (
            <button
              type="button"
              className="px-2 py-1 rounded border border-red-200 text-red-700 text-xs hover:bg-red-50"
              onClick={() => onDelete(profile.id)}
              disabled={busy}
            >
              删除
            </button>
          )}
        </div>
      </div>

      {testResult && (
        <p className={`text-xs mt-2 ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
          {testResult.ok
            ? `测试通过${testResult.status ? ` (HTTP ${testResult.status})` : ''}`
            : `测试失败${testResult.status ? ` (HTTP ${testResult.status})` : ''}${testResult.error ? `: ${testResult.error}` : ''}`}
        </p>
      )}
    </div>
  );
}
