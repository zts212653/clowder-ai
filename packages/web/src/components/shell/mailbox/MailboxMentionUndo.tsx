import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';

/** Message owner holds the last receipt; navigation, reload and browser storage do not own its lifetime. */
export function MailboxMentionUndo({
  owner,
  disabled = false,
  visible = true,
}: {
  owner: string | undefined;
  disabled?: boolean;
  visible?: boolean;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const [receipt, setReceipt] = useState<{ undoId: string; handled: number; remaining: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setReceipt(null);
    setNotice(null);
    if (!owner) return;
    let live = true;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const response = await apiFetch('/api/concierge/work/mentions/last-handling');
        if (!response.ok) throw new Error(t.undoReadFailed);
        const body = await response.json();
        if (!live || current !== generation) return;
        if (body.ownerUserId !== owner) throw new Error(t.undoOwnerUnknown);
        const value = body.receipt;
        if (
          value !== null &&
          (typeof value?.undoId !== 'string' ||
            !Number.isSafeInteger(value?.handled) ||
            value.handled < 1 ||
            !Number.isSafeInteger(value.remaining) ||
            value.remaining < 0 ||
            value.remaining > value.handled)
        )
          throw new Error(t.undoRecordUnavailable);
        setReceipt(value);
      } catch (e) {
        if (live && current === generation) {
          setReceipt(null);
          setNotice(e instanceof Error ? e.message : t.undoReadFailed);
        }
      }
    };
    void load();
    window.addEventListener('cat-cafe:user-mention-updated', load);
    return () => {
      live = false;
      window.removeEventListener('cat-cafe:user-mention-updated', load);
    };
  }, [owner, t]);
  async function undo() {
    if (!receipt) return;
    setBusy(true);
    try {
      const response = await apiFetch('/api/concierge/work/mentions/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ undoId: receipt.undoId }),
      });
      if (!response.ok) throw new Error(t.undoExpired);
      const result = await response.json();
      setNotice(t.undoResult(result.restored) + (result.restored < receipt.remaining ? t.undoNewerChanges : ''));
      setReceipt(null);
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t.undoFailed);
    } finally {
      setBusy(false);
    }
  }
  if (!owner || !visible) return null;
  return (
    <div className="mb-2 text-xs">
      {receipt && receipt.remaining > 0 ? (
        <button
          type="button"
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs disabled:opacity-50"
          disabled={disabled || busy}
          onClick={() => void undo()}
          data-testid="mailbox-mentions-undo"
        >
          {t.undoBatchLabel(receipt.remaining, receipt.handled)}
        </button>
      ) : null}
      {notice ? (
        <p role="status" className="m-0">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
