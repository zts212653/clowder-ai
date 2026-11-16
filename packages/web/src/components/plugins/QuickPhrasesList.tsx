'use client';

import { useEffect, useRef, useState } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { QuickPhraseConfirmation } from './QuickPhraseConfirmation';
import { quickPhrasesCopy } from './quick-phrases.shell-copy';
import { type QuickPhrase, type QuickPhrasesEntry, type QuickPhrasesPage, readQuickPhrases } from './quick-phrases-api';

const button = 'shell-focusable rounded-md px-2 py-1 text-sm hover:bg-cafe-surface-elevated disabled:opacity-40';

export function QuickPhrasesList({
  entry,
  onSelect,
}: {
  entry: QuickPhrasesEntry;
  onSelect: (phrase: QuickPhrase) => void;
}) {
  const t = useShellCopy(quickPhrasesCopy);
  const [request, setRequest] = useState({ query: '', page: 1 });
  const [result, setResult] = useState<QuickPhrasesPage | 'error'>();
  const [remove, setRemove] = useState<QuickPhrase>();
  const search = useRef<HTMLInputElement>(null);
  const { pluginId, instanceId, generation, resourcePath } = entry;
  const { query } = request;
  const reload = () => setRequest((current) => ({ ...current }));

  useEffect(() => {
    if (!remove) search.current?.focus();
  }, [remove]);
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    const timer = window.setTimeout(
      () => {
        void readQuickPhrases(
          { pluginId, instanceId, generation, resourcePath },
          request.query,
          request.page,
          controller.signal,
        )
          .then((data) => {
            if (!controller.signal.aborted) setResult(data);
          })
          .catch(() => {
            if (!controller.signal.aborted) setResult('error');
          });
      },
      request.query ? 120 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [request, pluginId, instanceId, generation, resourcePath]);

  if (remove)
    return (
      <QuickPhraseConfirmation
        entry={entry}
        intent={{ kind: 'delete', phrase: remove }}
        onCancel={() => setRemove(undefined)}
        onSuccess={() => {
          setRemove(undefined);
          reload();
        }}
      />
    );

  return (
    <div className="space-y-2 p-2">
      <input
        ref={search}
        type="search"
        aria-label={t.search}
        placeholder={t.search}
        tabIndex={0}
        maxLength={512}
        className="shell-focusable w-full rounded-md border border-[var(--shell-hairline)] bg-transparent px-2 py-1.5 text-sm"
        value={query}
        onChange={(event) => setRequest({ query: event.target.value, page: 1 })}
      />
      {result === 'error' && (
        <div role="alert" className="text-sm">
          {t.readFailed}{' '}
          <button type="button" className={button} onClick={reload}>
            {t.retry}
          </button>
        </div>
      )}
      {!result && <output className="block p-1 text-sm text-cafe-muted">{t.loading}</output>}
      {result &&
        result !== 'error' &&
        (result.items.length ? (
          <>
            <ul className="space-y-1">
              {result.items.map((phrase) => (
                <li
                  key={phrase.id}
                  className="flex items-center gap-1 rounded-md border border-[var(--shell-hairline)]"
                >
                  <button
                    type="button"
                    title={phrase.text}
                    onClick={() => onSelect(phrase)}
                    className={`${button} min-w-0 flex-1 text-left`}
                  >
                    <span className="line-clamp-2 whitespace-pre-wrap break-words">{phrase.text}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t.remove}
                    title={t.remove}
                    onClick={() => setRemove(phrase)}
                    className={`${button} m-0.5 shrink-0 text-cafe-muted hover:text-conn-red-text`}
                  >
                    <svg
                      aria-hidden="true"
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-1 text-xs text-cafe-muted">
              <button
                type="button"
                className={button}
                disabled={result.page === 1}
                onClick={() => setRequest({ query, page: result.page - 1 })}
              >
                {t.previous}
              </button>
              <output>{t.page(result.page, result.totalPages)}</output>
              <button
                type="button"
                className={button}
                disabled={result.page >= result.totalPages}
                onClick={() => setRequest({ query, page: result.page + 1 })}
              >
                {t.next}
              </button>
            </div>
          </>
        ) : (
          <output className="block p-1 text-sm text-cafe-muted">{query.trim() ? t.noResults : t.empty}</output>
        ))}
    </div>
  );
}
