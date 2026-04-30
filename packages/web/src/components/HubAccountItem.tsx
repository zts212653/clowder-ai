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

function summaryText(profile: ProfileItem): string | null {
  if (profile.builtin) return profile.authType === 'oauth' ? 'OAuth' : '内置';
  const host = profile.baseUrl?.replace(/^https?:\/\//, '') ?? '(未设置)';
  return `${host} · ${profile.authType === 'oauth' ? 'OAuth' : 'API Key'}`;
}

export function HubAccountItem({ profile, busy, onDelete, onEdit }: HubAccountItemProps) {
  const confirm = useConfirm();
  const editable = !profile.builtin && !!onEdit;

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
      className={`flex h-24 items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)] ${editable ? 'cursor-pointer' : ''}`}
      onClick={() => editable && onEdit(profile.id)}
    >
      <svg className="h-[18px] w-[18px] shrink-0 text-cafe-muted" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="5" r="1.5" />
        <circle cx="15" cy="5" r="1.5" />
        <circle cx="9" cy="12" r="1.5" />
        <circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="19" r="1.5" />
        <circle cx="15" cy="19" r="1.5" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{profile.displayName}</p>
        <p className="mt-1 truncate text-[12px] text-cafe-secondary">{summaryText(profile)}</p>
      </div>

      <div className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
        {profile.builtin ? (
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--console-card-soft-bg)]">
            <HubIcon name="shield" className="h-4 w-4 text-cafe-muted" />
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={handleDelete}
            className={`flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--console-card-soft-bg)] transition-opacity hover:opacity-80 ${busy ? 'opacity-50' : ''}`}
            title="删除"
          >
            <HubIcon name="trash" className="h-4 w-4 text-[var(--cafe-accent)]" />
          </button>
        )}
      </div>
    </div>
  );
}
