import { useShellCopy } from '../shell/shell-copy';
import { newConversationCopy } from './new-conversation.shell-copy';
import type { NewConversationAdmission } from './useNewConversationAdmission';

export function LocalDraftSaveNotice({
  state,
  onRetry,
  onCancel,
}: {
  state: Exclude<NewConversationAdmission['localSaveState'], 'idle'>;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const copy = useShellCopy(newConversationCopy);
  const saving = state === 'saving';
  const message = { saving: copy.savingDraft, failed: copy.saveFailed, cancelled: copy.saveCancelled }[state];
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
        className="shell-focusable rounded-lg px-2 py-1 font-medium"
        onClick={saving ? onCancel : onRetry}
        data-testid={saving ? 'new-conversation-cancel-save' : 'new-conversation-retry-save'}
      >
        {saving ? copy.cancelSave : copy.retrySave}
      </button>
    </div>
  );
}
