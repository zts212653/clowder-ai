'use client';

import { useState } from 'react';
import type { ProfileItem } from './hub-accounts.types';
import { builtinClientLabel } from './hub-accounts.view';
import { TagEditor } from './hub-tag-editor';
import { SettingsBadge, SettingsDeleteButton, SettingsRow } from './settings/primitives';
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

function summaryMeta(profile: ProfileItem): string {
  const parts: string[] = [];
  if (profile.authType === 'oauth') {
    const label = profile.clientId ? builtinClientLabel(profile.clientId) : null;
    if (label) parts.push(label);
  } else {
    const host = profile.baseUrl?.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
    if (host) parts.push(host);
    parts.push(profile.hasApiKey ? '已配置' : '未配置');
  }
  parts.push(`${profile.models?.length ?? 0} 模型`);
  return parts.join(' · ');
}

export function HubAccountItem({ profile, busy, onSave, onDelete, onEdit }: HubAccountItemProps) {
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);

  return (
    <SettingsRow
      title={profile.displayName}
      meta={summaryMeta(profile)}
      badges={
        <SettingsBadge tone={profile.authType === 'oauth' ? 'amber' : 'purple'}>
          {profile.authType === 'oauth' ? 'oauth' : 'api_key'}
        </SettingsBadge>
      }
      actions={
        <SettingsDeleteButton
          disabled={busy}
          aria-label="删除账号"
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
        />
      }
      onClick={onEdit ? () => onEdit(profile) : undefined}
      expanded={expanded}
      onToggle={() => setExpanded((prev) => !prev)}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper for inline editing */}
      <div role="group" onClick={(e) => e.stopPropagation()}>
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
    </SettingsRow>
  );
}
