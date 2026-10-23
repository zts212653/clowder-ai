'use client';

import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';
import { messageDispositionCopy } from './message-disposition.shell-copy';
import { useShellCopy } from './shell/shell-copy';

/** Only this message changes here. Persisted defaults belong to Settings. */
export function MessageDispositionSelector({
  controller,
  onBack,
  presentation = 'classic',
}: {
  controller: MessageDispositionPreferenceController;
  onBack: () => void;
  presentation?: 'classic' | 'v2';
}) {
  const localized = useShellCopy(messageDispositionCopy);
  const t = (presentation === 'v2' ? localized : messageDispositionCopy.zh).composer;
  return (
    <div data-testid="message-disposition-panel" className="p-2.5">
      <div className="flex items-center gap-2 pb-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t.back}
          className="h-8 w-8 rounded text-cafe-muted hover:bg-cafe-surface"
        >
          ←
        </button>
        <span className="text-sm font-medium text-cafe-primary">{t.heading}</span>
        <span className="text-xs text-cafe-muted">{t.once}</span>
      </div>
      <div className="grid gap-1">
        {(['next_work', 'continue_current'] as const).map((disposition) => (
          <button
            key={disposition}
            type="button"
            data-disposition-option={disposition}
            aria-pressed={controller.effective === disposition}
            onClick={() => {
              controller.setOneShot(disposition);
              onBack();
            }}
            className={`rounded-lg px-3 py-2 text-left hover:bg-cafe-surface-elevated ${controller.effective === disposition ? 'bg-cafe-surface-elevated' : ''}`}
          >
            <span className="block text-sm text-cafe-primary">{t.label[disposition]}</span>
            <span className="block text-xs text-cafe-muted">{t.note[disposition]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
