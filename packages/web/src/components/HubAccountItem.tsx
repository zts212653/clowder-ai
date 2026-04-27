'use client';

import type { ProfileItem } from './hub-accounts.types';
import { builtinClientLabel } from './hub-accounts.view';
import { TagEditor } from './hub-tag-editor';
import { useConfirm } from './useConfirm';

export interface ProfileEditPayload {
  displayName: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  modelOverride?: string | null;
}

interface HubAccountItemProps {
  profile: ProfileItem;
  busy: boolean;
  onSave: (profileId: string, payload: ProfileEditPayload) => Promise<void>;
  onDelete: (profileId: string) => void;
  onEdit?: (profile: ProfileItem) => void;
}

function summaryText(profile: ProfileItem): string | null {
  if (profile.authType === 'oauth') {
    const label = profile.clientId ? builtinClientLabel(profile.clientId) : null;
    return label ? `${label} · OAuth` : 'OAuth';
  }
  const host = profile.baseUrl?.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  const keyStatus = profile.hasApiKey ? '已配置' : '未配置';
  return host ? `${host} · ${keyStatus}` : keyStatus;
}

export function HubAccountItem({ profile, busy, onSave, onDelete, onEdit }: HubAccountItemProps) {
  const confirm = useConfirm();

  return (
    <div
      className={`rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px] transition ${onEdit ? 'cursor-pointer hover:border-[#D49266]/40' : ''}`}
      onClick={() => onEdit?.(profile)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-bold text-[#2D2118]">{profile.displayName}</span>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                profile.authType === 'oauth' ? 'bg-[#FFF3E0] text-[#D49266]' : 'bg-[#F3E8FF] text-[#9D7BC7]'
              }`}
            >
              {profile.authType === 'oauth' ? 'oauth' : 'api_key'}
            </span>
          </div>
          {summaryText(profile) ? <p className="text-sm text-[#8A776B]">{summaryText(profile)}</p> : null}
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-semibold text-[#8A776B]">可用模型</p>
            <TagEditor
              tags={profile.models ?? []}
              tone={profile.authType === 'oauth' ? 'orange' : 'purple'}
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
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="rounded-full bg-red-50 p-2 text-red-600 transition hover:bg-red-100 disabled:opacity-50"
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
            aria-label="删除账号"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" aria-hidden="true">
              <path
                d="M3.5 4.5h9m-7.5 0V3.25h5V4.5m-5.5 0 .5 8h5l.5-8m-4 2v4m2-4v4"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
