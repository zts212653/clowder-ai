'use client';

import type { HiddenSuggestionKind } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell/shell-copy';
import { SuggestionAvatar } from './SuggestionRow';
import { suggestionCopy, suggestionKindLabel } from './suggestion-copy';

const rowKey = (row: Pick<HiddenSuggestionKind, 'catId' | 'kind'>) => `${row.catId}\u001f${row.kind}`;

/**
 * 设置 › 你 ›「已隐藏的建议」：猫决定不再提的种类都在这一处，一行一个，点「恢复」。
 * Nothing hidden → no card (F335 KD-8：调节器不新增控制面).
 */
export function HiddenSuggestionsCard() {
  const copy = useShellCopy(suggestionCopy);
  const [rows, setRows] = useState<HiddenSuggestionKind[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void apiFetch('/api/suggestions/hidden-kinds')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { hidden?: HiddenSuggestionKind[] } | null) => {
        if (alive && Array.isArray(body?.hidden)) setRows(body.hidden);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const restore = useCallback(async (row: HiddenSuggestionKind) => {
    setRestoring(rowKey(row));
    const response = await apiFetch('/api/suggestions/hidden-kinds/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: row.catId, kind: row.kind }),
    }).catch(() => null);
    setRestoring(null);
    if (response?.ok) setRows((current) => current.filter((item) => rowKey(item) !== rowKey(row)));
  }, []);

  if (rows.length === 0) return null;
  return (
    <section className="you-settings-card" aria-label={copy.hidden} data-testid="hidden-suggestions-card">
      <div className="you-settings-card-heading">
        <h2>{copy.hidden}</h2>
        <span />
      </div>
      <div className="w-hidden-list">
        {rows.map((row) => (
          <div className="w-hidden-row" key={rowKey(row)}>
            <SuggestionAvatar catId={row.catId} watcher={row.byline === 'watcher'} />
            <span className="name">{suggestionKindLabel(copy, row.kind, row.kindLabel)}</span>
            <button
              type="button"
              className="restore"
              disabled={restoring === rowKey(row)}
              onClick={() => void restore(row)}
            >
              {copy.restore}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
