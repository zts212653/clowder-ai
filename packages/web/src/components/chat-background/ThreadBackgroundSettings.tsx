'use client';

import { NO_CHAT_BACKGROUND, resolveChatBackground } from '@cat-cafe/shared';
import { useState } from 'react';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import { useShellCopy } from '../shell/shell-copy';
import { backgroundCopy } from './background-copy';
import { backgroundName, ChatBackgroundPicker } from './ChatBackgroundPicker';
import { useChatBackgroundPreferences } from './ChatBackgroundProvider';

export function ThreadBackgroundSettings({
  threadId,
  pinned,
  onTogglePin,
  onOpen,
}: {
  threadId: string;
  pinned?: boolean;
  onTogglePin?: () => Promise<boolean>;
  onOpen(): void;
}) {
  const copy = useShellCopy(backgroundCopy);
  const controller = useChatBackgroundPreferences();
  const current = controller ? resolveChatBackground(controller.preferences, threadId) : NO_CHAT_BACKGROUND;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="thread-background-settings">
      <label className="thread-background-menu-row">
        <span>{pinned ? copy.pinned : copy.pin}</span>
        <input
          type="checkbox"
          checked={pinned ?? false}
          disabled={!onTogglePin || saving}
          onChange={async () => {
            setSaving(true);
            setFailed(false);
            try {
              setFailed(!(await onTogglePin?.()));
            } catch {
              setFailed(true);
            } finally {
              setSaving(false);
            }
          }}
        />
      </label>
      {failed && (
        <p role="alert" className="px-3 text-xs text-conn-red-text">
          {copy.pinFailed}
        </p>
      )}
      <button
        type="button"
        className="thread-background-menu-row shell-focusable"
        data-testid="thread-background-entry"
        onClick={onOpen}
      >
        <span>{copy.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {current.kind === 'image' && (
            <AvatarImageWithFallback src={current.url} alt="" className="h-[18px] w-7 rounded object-cover" />
          )}
          <span className="max-w-28 truncate">{backgroundName(current, copy)}</span>
          <span aria-hidden="true">›</span>
        </span>
      </button>
    </div>
  );
}

export function ThreadBackgroundDetail({ threadId, onBack }: { threadId: string; onBack(): void }) {
  const copy = useShellCopy(backgroundCopy);
  return (
    <div className="p-3.5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="shell-focusable flex items-center gap-2 text-sm font-semibold"
          aria-label={copy.back}
          data-background-back
        >
          <span aria-hidden="true">‹</span>
          {copy.title}
        </button>
        <span className="text-xs" style={{ color: 'var(--shell-muted)' }}>
          {copy.thread}
        </span>
      </div>
      <ChatBackgroundPicker threadId={threadId} />
    </div>
  );
}
