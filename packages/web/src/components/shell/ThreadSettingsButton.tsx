'use client';

import { useRef } from 'react';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { AppTooltip } from '../AppTooltip';
import { useThreadSettingsState } from '../ThreadSidebar/ThreadSettingsProvider';
import { ShellGlyph } from './ShellIcons';
import { useShellCopy } from './shell-copy';
import { threadSettingsCopy } from './thread-settings.shell-copy';

export function ThreadSettingsButton({ threadId }: { threadId: string }) {
  const copy = useShellCopy(threadSettingsCopy);
  const settings = useThreadSettingsState();
  const { currentThread } = useThreadDisplayInfo(threadId);
  const trigger = useRef<HTMLButtonElement>(null);
  const expanded = settings?.threadId === threadId;
  if (threadId === 'default') return null;
  return (
    <AppTooltip label={copy.title} side="bottom" disabled={expanded}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={`thread-settings-${threadId}`}
        aria-label={copy.title}
        disabled={!settings || !currentThread}
        onClick={() => settings?.toggle(threadId, trigger)}
        className="shell-rail-item shell-focusable flex h-8 w-8 flex-none items-center justify-center rounded-lg"
        style={{ color: 'var(--shell-muted)' }}
        data-testid="thread-settings-toggle"
      >
        <ShellGlyph name="more" />
      </button>
    </AppTooltip>
  );
}
