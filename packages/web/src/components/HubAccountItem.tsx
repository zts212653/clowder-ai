'use client';

import type { ProfileItem } from './hub-accounts.types';
import { builtinClientLabel } from './hub-accounts.view';
import { SettingsBadge, SettingsDeleteButton, SettingsRow } from './settings/primitives';
import { useConfirm } from './useConfirm';

interface HubAccountItemProps {
  profile: ProfileItem;
  busy: boolean;
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
  if (profile.models && profile.models.length > 0) {
    parts.push(profile.models.join(', '));
  } else {
    parts.push('0 模型');
  }
  return parts.join(' · ');
}

export function HubAccountItem({ profile, busy, onDelete, onEdit }: HubAccountItemProps) {
  const confirm = useConfirm();

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
    />
  );
}
