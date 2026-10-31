'use client';

import { useId } from 'react';
import { useProcessTalkPreference } from '@/hooks/useProcessTalkPreference';
import { processTalkCopy } from '../reply-layers/process-talk.shell-copy';
import { useShellCopy } from '../shell/shell-copy';

export function ProcessTalkSettings() {
  const preference = useProcessTalkPreference();
  const t = useShellCopy(processTalkCopy);
  const groupName = useId();
  const busy = preference.status === 'idle' || preference.status === 'loading' || preference.status === 'saving';
  return (
    <section aria-labelledby="process-talk-heading" data-testid="process-talk-settings">
      <h3 id="process-talk-heading" className="text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
        {t.title}
      </h3>
      <p className="mt-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
        {t.note}
      </p>
      <div
        role="radiogroup"
        aria-labelledby="process-talk-heading"
        aria-busy={busy}
        className="mt-2 flex flex-col gap-1.5"
      >
        {(['whole', 'record'] as const).map((mode) => (
          <label
            key={mode}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm"
            style={{
              color: 'var(--shell-ink)',
              border: '1px solid var(--shell-hairline)',
              background: preference.mode === mode ? 'var(--shell-selected)' : 'var(--shell-paper)',
            }}
          >
            <input
              type="radio"
              name={groupName}
              checked={preference.mode === mode}
              aria-checked={preference.mode === mode}
              disabled={busy || !preference.snapshot}
              data-testid={`process-talk-${mode}`}
              onChange={() => void preference.save(mode)}
              className="shell-focusable h-3.5 w-3.5 flex-none"
              style={{ accentColor: 'var(--shell-ink)' }}
            />
            {t[mode]}
          </label>
        ))}
      </div>
      <output aria-live="polite" className="mt-1 block text-xs" style={{ color: 'var(--shell-muted)' }}>
        {busy
          ? preference.status === 'saving'
            ? t.saving
            : t.loading
          : preference.error === 'load'
            ? t.loadError
            : preference.error === 'save'
              ? t.saveError
              : ''}
      </output>
      {preference.error && (
        <button type="button" className="shell-focusable mt-1 text-xs underline" onClick={() => void preference.load()}>
          {t.retry}
        </button>
      )}
    </section>
  );
}
