'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import { useState } from 'react';
import type {
  MessageDispositionPreferenceController,
  MessageDispositionPreferenceScope,
} from '@/hooks/useMessageDispositionPreference';
import { messageDispositionCopy } from './message-disposition.shell-copy';
import { useShellCopy } from './shell/shell-copy';

interface MessageDispositionSelectorProps {
  controller: MessageDispositionPreferenceController;
  onBack: () => void;
  presentation?: 'classic' | 'v2';
}

/** Strategy editor inside the composer's + menu. */
export function MessageDispositionSelector({
  controller,
  onBack,
  presentation = 'classic',
}: MessageDispositionSelectorProps) {
  const localized = useShellCopy(messageDispositionCopy);
  const t = (presentation === 'v2' ? localized : messageDispositionCopy.zh).composer;
  const [scope, setScope] = useState<MessageDispositionPreferenceScope>('thread');
  const selectedDisposition =
    scope === 'thread'
      ? (controller.snapshot.thread ?? controller.snapshot.global ?? controller.snapshot.productDefault)
      : (controller.snapshot.global ?? controller.snapshot.productDefault);

  const choose = async (disposition: MessageWorkDisposition) => {
    const saved = await controller.setPreference(scope, disposition);
    if (saved) onBack();
  };

  return (
    <div data-testid="message-disposition-panel">
      <div className="flex items-center gap-2 px-3 pb-2 pt-1.5">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-cafe-muted transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-primary"
          aria-label={t.back}
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-cafe-primary">{t.heading}</div>
        </div>
        {controller.loading ? <span className="text-micro text-cafe-muted">{t.syncing}</span> : null}
      </div>

      <div className="p-2.5">
        <fieldset className="mb-2 flex rounded-lg bg-cafe-surface p-0.5" aria-label={t.appliesTo}>
          {(['thread', 'global'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-disposition-scope={candidate}
              aria-pressed={scope === candidate}
              onClick={() => setScope(candidate)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                scope === candidate
                  ? 'bg-cafe-surface-sunken font-medium text-cafe-primary shadow-sm'
                  : 'text-cafe-muted hover:text-cafe-secondary'
              }`}
            >
              {t.scope[candidate]}
            </button>
          ))}
        </fieldset>

        <div className="grid gap-1 rounded-lg bg-cafe-surface p-1">
          {(['next_work', 'continue_current'] as const).map((disposition) => (
            <button
              key={disposition}
              type="button"
              data-disposition-option={disposition}
              aria-pressed={selectedDisposition === disposition}
              disabled={controller.loading}
              onClick={() => void choose(disposition)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-cafe-surface-sunken disabled:cursor-wait disabled:opacity-60 ${
                selectedDisposition === disposition ? 'bg-cafe-surface-sunken' : ''
              }`}
            >
              <span
                className={`h-2 w-2 flex-none rounded-full ${
                  selectedDisposition === disposition
                    ? 'bg-[var(--color-cocreator-primary)]'
                    : 'border border-[var(--console-border-strong)]'
                }`}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-cafe-primary">{t.label[disposition]}</span>
                <span className="block text-xs text-cafe-muted">{t.note[disposition]}</span>
              </span>
            </button>
          ))}
        </div>

        {controller.error ? (
          <p role="alert" className="mt-1 px-0.5 text-micro text-conn-red-text">
            {controller.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
