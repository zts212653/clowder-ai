'use client';

import type { ProfileItem } from './hub-accounts.types';
import { HubIcon } from './hub-icons';
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
  onEdit?: (profileId: string) => void;
}

function summaryText(profile: ProfileItem): string {
  const parts: string[] = [];
  if (profile.baseUrl) {
    parts.push(profile.baseUrl.replace(/^https?:\/\//, ''));
  }
  parts.push(profile.authType === 'oauth' ? 'OAuth' : 'API Key');
  return parts.join(' · ');
}

export function HubAccountItem({ profile, busy, onDelete, onEdit }: HubAccountItemProps) {
  const confirm = useConfirm();

  const handleDelete = async () => {
    const ok = await confirm({
      title: '删除账号',
      message: `确定要删除「${profile.displayName}」吗？此操作不可撤销。`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (ok) onDelete(profile.id);
  };

  return (
    <div
      className="flex cursor-pointer items-center gap-3 rounded-2xl bg-[var(--console-card-bg)] px-4 py-3 shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)]"
      onClick={() => onEdit?.(profile.id)}
    >
      <svg className="h-[18px] w-[18px] shrink-0 cursor-grab text-cafe-muted" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="5" r="1.5" />
        <circle cx="15" cy="5" r="1.5" />
        <circle cx="9" cy="12" r="1.5" />
        <circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="19" r="1.5" />
        <circle cx="15" cy="19" r="1.5" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-cafe">{profile.displayName}</p>
        <p className="mt-0.5 truncate text-xs text-cafe-secondary">{summaryText(profile)}</p>
      </div>

      <div className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          disabled={busy}
          onClick={handleDelete}
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--console-card-soft-bg)] transition-opacity hover:opacity-80 ${busy ? 'opacity-50' : ''}`}
          title="删除"
        >
          <HubIcon name="trash" className="h-4 w-4 text-[var(--cafe-accent)]" />
        </button>
      </div>
    </div>
  );
}
