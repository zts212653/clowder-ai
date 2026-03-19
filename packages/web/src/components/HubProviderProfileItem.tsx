'use client';

import { useCallback, useState } from 'react';
import { TagEditor } from './hub-tag-editor';
import { accountTone, builtinClientLabel } from './hub-provider-profiles.view';
import type { ProfileItem, ProfileTestResult } from './hub-provider-profiles.types';

export interface ProfileEditPayload {
  displayName: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  modelOverride?: string | null;
}

interface HubProviderProfileItemProps {
  profile: ProfileItem;
  busy: boolean;
  testResult?: ProfileTestResult;
  onSave: (profileId: string, payload: ProfileEditPayload) => Promise<void>;
  onTest: (profileId: string) => void;
  onDelete: (profileId: string) => void;
}

function summaryText(profile: ProfileItem): string {
  if (profile.builtin) {
    const authLabel =
      profile.client === 'dare' || profile.client === 'opencode' ? '内置 client-auth 账号' : '内置 OAuth 账号';
    return `${builtinClientLabel(profile.client)} · ${authLabel} · 成员可直接绑定`;
  }
  const host = profile.baseUrl?.replace(/^https?:\/\//, '') ?? '(未设置)';
  return `独立 API Key 账号 · ${host} · apiKey: ${profile.hasApiKey ? '已配置' : '未配置'}`;
}

function bindingBadgeClass(profile: ProfileItem): string {
  const tone = accountTone(profile);
  if (tone === 'orange') return 'bg-[#FFF4EC] text-[#C8946B]';
  if (tone === 'green') return 'bg-[#E8F5E9] text-[#2E7D32]';
  return 'bg-[#F3E8FF] text-[#9D7BC7]';
}

function verificationBadge(testResult?: ProfileTestResult) {
  if (!testResult) {
    return {
      label: '未验证',
      className: 'bg-[#FFF7E1] text-[#B58100]',
    };
  }
  if (testResult.ok) {
    return {
      label: '验证',
      className: 'bg-[#E8F5E9] text-[#2E7D32]',
    };
  }
  return {
    label: '验证失败',
    className: 'bg-[#EAF2FF] text-[#2F6FDE]',
  };
}

export function HubProviderProfileItem({
  profile,
  busy,
  testResult,
  onSave,
  onTest,
  onDelete,
}: HubProviderProfileItemProps) {
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState(profile.displayName);
  const [editBaseUrl, setEditBaseUrl] = useState(profile.baseUrl ?? '');
  const [editApiKey, setEditApiKey] = useState('');

  const startEdit = useCallback(() => {
    setEditDisplayName(profile.displayName);
    setEditBaseUrl(profile.baseUrl ?? '');
    setEditApiKey('');
    setEditing(true);
  }, [profile.baseUrl, profile.displayName]);

  const saveEdit = useCallback(async () => {
    await onSave(profile.id, {
      displayName: editDisplayName.trim(),
      ...(profile.authType === 'api_key' && editBaseUrl.trim() ? { baseUrl: editBaseUrl.trim() } : {}),
      ...(editApiKey.trim() ? { apiKey: editApiKey.trim() } : {}),
      ...(profile.models ? { models: profile.models } : {}),
    });
    setEditing(false);
  }, [editApiKey, editBaseUrl, editDisplayName, onSave, profile.authType, profile.id, profile.models]);

  const showTestButton = profile.authType === 'api_key';
  const statusBadge = verificationBadge(testResult);

  if (editing) {
    return (
      <div className="space-y-3 rounded-[20px] border-2 border-[#E8C9AF] bg-[#FFF8F2] p-[18px]">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <input
            value={editDisplayName}
            onChange={(e) => setEditDisplayName(e.target.value)}
            placeholder="账号显示名"
            className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm"
          />
          <div className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#8A776B]">
            {profile.builtin ? builtinClientLabel(profile.client) : '独立 API Key 账号'} · {profile.authType}
            {profile.builtin ? ' · 🔒 内置' : ''}
          </div>
          {profile.authType === 'api_key' ? (
            <>
              <input
                value={editBaseUrl}
                onChange={(e) => setEditBaseUrl(e.target.value)}
                placeholder="Base URL"
                className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
              />
              <input
                value={editApiKey}
                onChange={(e) => setEditApiKey(e.target.value)}
                placeholder={profile.hasApiKey ? 'API Key（留空保持不变）' : 'API Key'}
                className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
              />
            </>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={saveEdit}
            disabled={busy}
            className="rounded bg-[#D49266] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#c47f52] disabled:opacity-50"
          >
            {busy ? '保存中...' : '保存'}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            className="rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-bold text-[#2D2118]">{profile.displayName}</span>
            {profile.builtin ? <span className="text-[11px] font-semibold text-[#8A776B]">🔒 内置</span> : null}
            {!profile.builtin ? (
              <span className="rounded-full bg-[#F3E8FF] px-2.5 py-1 text-[11px] font-semibold text-[#9D7BC7]">api_key</span>
            ) : null}
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusBadge.className}`}>
              {statusBadge.label}
            </span>
          </div>
          <p className="text-sm text-[#8A776B]">{summaryText(profile)}</p>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#8A776B]">绑定范围</p>
            <div className="flex flex-wrap gap-2">
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${bindingBadgeClass(profile)}`}>
                {profile.builtin ? `固定内置账号：${builtinClientLabel(profile.client)}` : '可被任意 client 成员绑定'}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#8A776B]">可用模型</p>
            <TagEditor
              tags={profile.models ?? []}
              tone={profile.builtin ? 'orange' : 'purple'}
              addLabel="+ 添加"
              placeholder="输入模型名"
              emptyLabel="(暂无模型)"
              onChange={(nextModels) => {
                if (busy) return;
                void onSave(profile.id, {
                  displayName: profile.displayName,
                  ...(profile.authType === 'api_key' && profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
                  models: nextModels,
                });
              }}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {showTestButton ? (
            <button
              type="button"
              className="rounded-full bg-[#F7F3F0] px-3 py-1.5 text-xs font-semibold text-[#8A776B]"
              onClick={() => onTest(profile.id)}
              disabled={busy}
            >
              测试
            </button>
          ) : null}
          {!profile.builtin ? (
            <button
              type="button"
              className="rounded-full bg-[#F7F3F0] px-3 py-1.5 text-xs font-semibold text-[#8A776B]"
              onClick={startEdit}
              disabled={busy}
            >
              编辑
            </button>
          ) : null}
          {!profile.builtin ? (
            <button
              type="button"
              className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600"
              onClick={() => onDelete(profile.id)}
              disabled={busy}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>

      {testResult?.ok === false || testResult?.message ? (
        <p className={`mt-3 text-xs ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
          {testResult.ok
            ? `测试通过${testResult.status ? ` (HTTP ${testResult.status})` : ''}`
            : `测试失败${testResult.status ? ` (HTTP ${testResult.status})` : ''}${testResult.error ? `: ${testResult.error}` : ''}`}
        </p>
      ) : null}
    </div>
  );
}
