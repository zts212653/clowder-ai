'use client';

import type { MessageDispositionPreferenceSnapshot, MessageWorkDisposition } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { messageDispositionCopy } from '@/components/message-disposition.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { apiFetch } from '@/utils/api-client';

function isDisposition(value: unknown): value is MessageWorkDisposition {
  return value === 'next_work' || value === 'continue_current';
}

function isSnapshot(value: unknown): value is MessageDispositionPreferenceSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MessageDispositionPreferenceSnapshot>;
  return (
    isDisposition(candidate.productDefault) &&
    (candidate.global === null || isDisposition(candidate.global)) &&
    (candidate.thread === null || isDisposition(candidate.thread)) &&
    isDisposition(candidate.effective)
  );
}

async function readSnapshot(response: Response): Promise<MessageDispositionPreferenceSnapshot> {
  if (!response.ok) throw new Error(`message disposition request rejected (${response.status})`);
  const body: unknown = await response.json();
  if (!isSnapshot(body)) throw new Error('message disposition response is incomplete');
  return body;
}

/** F322 retained slice: the v2 System home for F264's owner-scoped global default. */
export function MessageDispositionDefaultSettings() {
  const t = useShellCopy(messageDispositionCopy).settings;
  const [snapshot, setSnapshot] = useState<MessageDispositionPreferenceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<MessageWorkDisposition | null>(null);
  const [error, setError] = useState<'load' | 'save' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await readSnapshot(await apiFetch('/api/config/message-disposition')));
    } catch {
      setError('load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (disposition: MessageWorkDisposition) => {
    if (!snapshot || pending) return;
    setPending(disposition);
    setError(null);
    try {
      const next = await readSnapshot(
        await apiFetch('/api/config/message-disposition', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'global', disposition }),
        }),
      );
      setSnapshot(next);
    } catch {
      setError('save');
    } finally {
      setPending(null);
    }
  };

  const displayed = pending ?? snapshot?.global ?? snapshot?.productDefault;
  const options = [
    { value: 'next_work' as const, label: t.nextLabel, note: t.nextNote },
    { value: 'continue_current' as const, label: t.continueLabel, note: t.continueNote },
  ];

  return (
    <section aria-labelledby="message-disposition-default-heading" className="space-y-2">
      <div>
        <h3
          id="message-disposition-default-heading"
          className="text-sm font-semibold"
          style={{ color: 'var(--shell-ink)' }}
        >
          {t.heading}
        </h3>
        <p className="mt-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.note}
        </p>
      </div>

      {snapshot ? (
        <div
          role="radiogroup"
          aria-labelledby="message-disposition-default-heading"
          aria-busy={pending !== null}
          className="flex flex-col gap-1.5"
        >
          {options.map(({ value, label, note }) => (
            <label
              key={value}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                pending ? 'cursor-wait opacity-70' : 'cursor-pointer'
              }`}
              style={{
                background: displayed === value ? 'var(--shell-selected)' : 'var(--shell-paper)',
                border: '1px solid var(--shell-hairline)',
                color: 'var(--shell-ink)',
              }}
            >
              <input
                type="radio"
                name="message-disposition-default"
                data-testid={`message-disposition-default-${value}`}
                checked={displayed === value}
                disabled={pending !== null}
                onChange={() => void save(value)}
                className="shell-focusable h-3.5 w-3.5 flex-none accent-[var(--shell-ink)]"
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{label}</span>
                <span className="ml-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
                  {note}
                </span>
              </span>
            </label>
          ))}
          {pending ? (
            <output className="block text-xs" style={{ color: 'var(--shell-muted)' }}>
              {t.saving}
            </output>
          ) : null}
          {error === 'save' ? (
            <p role="alert" className="text-xs text-conn-rose-text">
              {t.saveFailed}
            </p>
          ) : null}
        </div>
      ) : error === 'load' ? (
        <div className="flex items-center gap-2 text-xs text-conn-rose-text" role="alert">
          <span>{t.loadFailed}</span>
          <button type="button" onClick={() => void load()} className="shell-focusable rounded px-2 py-1 underline">
            {t.retry}
          </button>
        </div>
      ) : loading ? (
        <output className="block text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.loading}
        </output>
      ) : null}
    </section>
  );
}
