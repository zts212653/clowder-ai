import { useEffect, useState } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { newConversationCopy } from './new-conversation.shell-copy';
import type { NewConversationAdmission } from './useNewConversationAdmission';

/**
 * A routine autosave settles within a frame or two. Mounting the in-flow notice for it
 * pushes the page down and back on every keystroke, so a save only earns the notice
 * (and its cancel action) once it is still running after this long.
 */
export const SAVE_NOTICE_DELAY_MS = 300;

export function useLingeringSave(saving: boolean): boolean {
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (!saving) {
      setLingering(false);
      return;
    }
    const timer = setTimeout(() => setLingering(true), SAVE_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [saving]);
  return saving && lingering;
}

export function LocalDraftSaveNotice({
  state,
  canCancel,
  preparingSend,
  onRetry,
  onCancel,
}: {
  state: Exclude<NewConversationAdmission['localSaveState'], 'idle'>;
  canCancel: boolean;
  preparingSend: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const copy = useShellCopy(newConversationCopy);
  const saving = state === 'saving';
  const message = {
    saving: preparingSend ? copy.preparingSend : canCancel ? copy.savingDraft : copy.finishingDraftSave,
    failed: copy.saveFailed,
    cancelled: copy.saveCancelled,
  }[state];
  return (
    <div
      className={`mt-3 flex flex-wrap items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm ${
        saving
          ? 'border-[var(--shell-hairline)] bg-[var(--shell-paper)] text-[var(--shell-muted)]'
          : 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text'
      }`}
      role={saving ? 'status' : 'alert'}
      data-testid="new-conversation-save-state"
      data-save-state={state}
    >
      <span>{message}</span>
      <button
        type="button"
        className="shell-focusable rounded-lg px-2 py-1 font-medium disabled:cursor-default disabled:opacity-50"
        disabled={saving && !canCancel}
        onClick={saving ? onCancel : onRetry}
        data-testid={saving ? 'new-conversation-cancel-save' : 'new-conversation-retry-save'}
      >
        {saving ? (preparingSend ? copy.cancelSendPreparation : copy.cancelSave) : copy.retrySave}
      </button>
    </div>
  );
}
