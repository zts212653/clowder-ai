'use client';

import { useEffect, useRef, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { useShellCopy } from '../shell/shell-copy';
import { requestPluginHttp } from './plugin-panel-http';
import { quickPhrasesCopy } from './quick-phrases.shell-copy';
import type { QuickPhrase, QuickPhrasesEntry } from './quick-phrases-api';

type Intent = { kind: 'save'; text: string } | { kind: 'delete'; phrase: QuickPhrase };

export function QuickPhraseConfirmation({
  entry,
  intent,
  onCancel,
  onSuccess,
}: {
  entry: QuickPhrasesEntry;
  intent: Intent;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const t = useShellCopy(quickPhrasesCopy);
  const saving = intent.kind === 'save';
  const operation = saving
    ? { method: 'POST', body: { text: intent.text } }
    : { method: 'DELETE', body: { id: intent.phrase.id } };
  const failureCopy: Readonly<Record<number, string>> = {
    400: saving ? t.tooLong : t.writeFailed,
    413: t.storageFull,
  };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const mutation = useRef<AbortController>();

  useEffect(() => {
    cancel.current?.focus();
    return () => mutation.current?.abort();
  }, []);

  async function confirm() {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError('');
    const response = await requestPluginHttp(
      entry,
      { ...operation, path: entry.resourcePath },
      controller.signal,
    ).catch(() => undefined);
    if (controller.signal.aborted) return;
    mutation.current = undefined;
    setBusy(false);
    if (response?.status !== 200) {
      setError(failureCopy[response?.status ?? 0] ?? t.writeFailed);
      return;
    }
    useToastStore
      .getState()
      .addToast({ type: 'success', title: t.title, message: saving ? t.saved : t.removed, duration: 2500 });
    onSuccess();
  }

  return (
    <div className="space-y-2 p-2">
      <h3 className="text-sm font-semibold">{saving ? t.save : t.confirmRemove}</h3>
      <p className="line-clamp-3 whitespace-pre-wrap break-words rounded-md bg-cafe-surface-sunken p-2 text-sm">
        {saving ? intent.text : intent.phrase.text}
      </p>
      {error && (
        <p role="alert" className="text-sm text-conn-red-text">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <button
          ref={cancel}
          type="button"
          className="shell-focusable rounded-md px-2 py-1 text-sm hover:bg-cafe-surface-elevated disabled:opacity-40"
          disabled={busy}
          onClick={onCancel}
        >
          {t.no}
        </button>
        <button
          type="button"
          className="shell-focusable rounded-md px-2 py-1 text-sm font-semibold hover:bg-cafe-surface-elevated disabled:opacity-40"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {t.yes}
        </button>
      </div>
    </div>
  );
}
