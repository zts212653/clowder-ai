'use client';

import { useCallback, useState } from 'react';
import type { ProfileItem } from './hub-provider-profiles.types';
import { TagEditor } from './hub-tag-editor';
import { useConfirm } from './useConfirm';

export interface ProfileEditPayload {
  displayName: string;
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  modelOverride?: string | null;
}

interface HubProviderProfileItemProps {
  profile: ProfileItem;
  busy: boolean;
  onSave: (profileId: string, payload: ProfileEditPayload) => Promise<void>;
  onDelete: (profileId: string) => void;
}

function summaryText(profile: ProfileItem): string | null {
  if (profile.builtin) return null;
  const host = profile.baseUrl?.replace(/^https?:\/\//, '') ?? '(未设置)';
  return `${host} · ${profile.hasApiKey ? '已配置' : '未配置'}`;
}

export function HubProviderProfileItem({ profile, busy, onSave, onDelete }: HubProviderProfileItemProps) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState(profile.displayName);
  const [editBaseUrl, setEditBaseUrl] = useState(profile.baseUrl ?? '');
  const [editApiKey, setEditApiKey] = useState('');
  const [editModels, setEditModels] = useState<string[]>(profile.models ?? []);

  const startEdit = useCallback(() => {
    setEditDisplayName(profile.displayName);
    setEditBaseUrl(profile.baseUrl ?? '');
    setEditApiKey('');
    setEditModels(profile.models ?? []);
    setEditing(true);
  }, [profile.baseUrl, profile.displayName, profile.models]);

  const saveEdit = useCallback(async () => {
    await onSave(profile.id, {
      displayName: editDisplayName.trim(),
      ...(profile.authType === 'api_key' ? { baseUrl: editBaseUrl.trim() } : {}),
      ...(editApiKey.trim() ? { apiKey: editApiKey.trim() } : {}),
      models: editModels,
    });
    setEditing(false);
  }, [editApiKey, editBaseUrl, editDisplayName, editModels, onSave, profile.authType, profile.id]);

  if (editing) {
    return (
      <div className="space-y-3 rounded-[20px] border-2 border-[#E8C9AF] bg-[#FFF8F2] p-[18px]">
        <div className="space-y-2">
          <input
            value={editDisplayName}
            onChange={(e) => setEditDisplayName(e.target.value)}
            placeholder="账号显示名"
            className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
          />
          {profile.authType === 'api_key' ? (
            <>
              <input
                value={editBaseUrl}
                onChange={(e) => setEditBaseUrl(e.target.value)}
                placeholder="API 服务地址，如 https://api.example.com/v1"
                className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
              />
              <div className="relative">
                <input
                  type="password"
                  autoComplete="off"
                  value={editApiKey}
                  onChange={(e) => setEditApiKey(e.target.value)}
                  placeholder={profile.hasApiKey ? '已配置 sk-••••••••（留空保持不变）' : 'sk-xxxxxxxxxxxxxxxx'}
                  className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
                />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-[#8A776B]">可用模型</p>
                <TagEditor
                  tags={editModels}
                  tone="purple"
                  addLabel="+ 添加模型"
                  placeholder="输入模型名，如 gpt-4o"
                  emptyLabel="(至少添加 1 个模型)"
                  minCount={1}
                  onChange={setEditModels}
                />
              </div>
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
            {profile.builtin ? (
              <span className="text-[11px] font-semibold text-[#8A776B] flex items-center gap-0.5">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
                内置
              </span>
            ) : null}
            {!profile.builtin ? (
              <span className="rounded-full bg-[#F3E8FF] px-2.5 py-1 text-[11px] font-semibold text-[#9D7BC7]">
                api_key
              </span>
            ) : null}
          </div>
          {summaryText(profile) ? <p className="text-sm text-[#8A776B]">{summaryText(profile)}</p> : null}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#8A776B]">可用模型</p>
            <TagEditor
              tags={profile.models ?? []}
              tone={profile.builtin ? 'orange' : 'purple'}
              addLabel="+ 添加"
              placeholder="输入模型名"
              emptyLabel="(暂无模型)"
              minCount={1}
              onChange={(nextModels) => {
                if (busy) return;
                void onSave(profile.id, {
                  displayName: profile.displayName,
                  ...(profile.authType === 'api_key' ? { baseUrl: profile.baseUrl ?? '' } : {}),
                  models: nextModels,
                });
              }}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
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
              onClick={async () => {
                if (
                  await confirm({
                    title: '删除确认',
                    message: `确认删除账号「${profile.displayName}」吗？该操作不可撤销。`,
                    variant: 'danger',
                    confirmLabel: '删除',
                  })
                ) {
                  onDelete(profile.id);
                }
              }}
              disabled={busy}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
