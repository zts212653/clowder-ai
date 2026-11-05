'use client';
import { useShellCopy } from '../shell/shell-copy';
import type { HubCatEditorController } from '../useHubCatEditor';
import { useMemberText } from './editor-presentation';
import { memberSaveCopy } from './member-save.shell-copy';

export function MemberSaveFeedback({
  editor: e,
  creating,
  onSave,
  classic = false,
}: {
  editor: HubCatEditorController;
  creating: boolean;
  onSave: () => void;
  classic?: boolean;
}) {
  const copy = useShellCopy(memberSaveCopy);
  const t = useMemberText();
  const reason = e.saveError ? t(e.saveError) : Object.values(e.fieldErrors).some(Boolean) ? copy.invalid : null;
  const changed = e.changes.length > 0;
  const time =
    e.savedAt === null
      ? copy.unknownTime
      : new Date(e.savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const text = e.saving ? (
    copy.saving
  ) : reason ? (
    copy.failed(reason)
  ) : changed ? (
    <>
      <strong className="member-unsaved-count">{copy.dirtyPrefix(e.changes.length)}</strong>
      {copy.dirtyFields(e.changes.map((change) => change.label))}
    </>
  ) : e.saveNotice === 'unchanged' ? (
    copy.noChangesToSave
  ) : e.saveNotice === 'saved' ? (
    `${copy.saved} · ${time} · ${e.savedConnection ? copy.nextWork : copy.updated}`
  ) : creating ? (
    copy.createHint
  ) : (
    `${copy.noChanges} · ${copy.lastSave} ${time}`
  );
  return (
    <div className="member-save-feedback" data-testid="member-save-feedback">
      <p
        className="member-save-status"
        role={reason ? 'alert' : 'status'}
        aria-live={reason ? 'assertive' : 'polite'}
        tabIndex={-1}
      >
        {text}
      </p>
      <div className="member-save-actions">
        {(changed || creating) && (
          <button
            type="button"
            className="member-button"
            disabled={e.saving}
            onClick={() => (creating ? void e.requestClose() : e.discard())}
          >
            {creating ? copy.cancel : copy.discard}
          </button>
        )}
        <button
          type="button"
          className="member-button member-primary"
          onClick={onSave}
          disabled={e.saving || e.restoringCloudIdentity || e.saveBlockedByProfileBinding}
        >
          {e.saving ? copy.saving : reason ? copy.retry : creating && !classic ? copy.add : copy.save}
        </button>
      </div>
    </div>
  );
}
