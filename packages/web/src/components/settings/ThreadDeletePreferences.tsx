'use client';

import { useState } from 'react';
import { useThreadDeletePreference } from '@/hooks/useThreadDeletePreference';
import { useShellCopy } from '../shell/shell-copy';
import { threadDeletionCopy } from '../ThreadSidebar/thread-deletion.shell-copy';

export function ThreadDeletePreferences() {
  const copy = useShellCopy(threadDeletionCopy);
  const preference = useThreadDeletePreference();
  const [saveFailed, setSaveFailed] = useState(false);
  return (
    <section className="you-settings-card" aria-label={copy.settingsTitle}>
      <div className="you-settings-card-heading">
        <h2>{copy.settingsTitle}</h2>
        <span>{copy.personalScope}</span>
      </div>
      <label className="flex items-start justify-between gap-5">
        <span>
          <span className="block text-sm font-medium text-cafe">{copy.confirmSetting}</span>
          <span className="mt-1 block text-xs leading-relaxed text-cafe-secondary">{copy.settingNote}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={preference.confirmBeforeDelete}
          aria-label={copy.confirmSetting}
          checked={preference.confirmBeforeDelete}
          disabled={!preference.ready}
          onChange={(event) => setSaveFailed(!preference.setConfirmBeforeDelete(event.target.checked))}
          className="shell-focusable mt-0.5 h-5 w-9 shrink-0 appearance-none rounded-full bg-neutral-400 p-[3px] transition-colors before:block before:h-3.5 before:w-3.5 before:rounded-full before:bg-cafe-surface-canvas before:transition-transform checked:bg-cafe-accent checked:before:translate-x-[15px] disabled:opacity-50"
        />
      </label>
      {saveFailed && (
        <p role="alert" className="mt-2 text-xs text-conn-red-text">
          {copy.preferenceFailed}
        </p>
      )}
    </section>
  );
}
