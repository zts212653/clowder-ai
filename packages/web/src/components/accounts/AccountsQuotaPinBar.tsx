'use client';

import { useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { AccountSelection, ProfileItem } from '../hub-accounts.types';
import { QuotaRingIcon } from '../shell/quota-pin/QuotaRingIcon';
import { quotaPinCopy } from '../shell/quota-pin/quota-pin.shell-copy';
import { buildQuotaRingModel } from '../shell/quota-pin/quota-pin-model';
import { useQuotaPinPreference } from '../shell/quota-pin/quota-pin-store';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';

export function AccountsQuotaPinBar({
  profiles,
  cats,
  codexSelection,
  claudeSelection,
  agySelection,
}: {
  profiles: readonly ProfileItem[];
  cats: CatData[];
  codexSelection?: AccountSelection;
  claudeSelection?: AccountSelection;
  agySelection?: AccountSelection;
}) {
  const t = useShellCopy(quotaPinCopy);
  const language = useShellLanguage();
  const pref = useQuotaPinPreference();
  const [choosing, setChoosing] = useState(false);

  const model = useMemo(
    () =>
      buildQuotaRingModel({
        profiles,
        cats,
        codexSelection,
        claudeSelection,
        agySelection,
        selectedAccountRefs: pref.selectedAccountRefs,
        now: Date.now(),
        language,
      }),
    [profiles, cats, codexSelection, claudeSelection, agySelection, pref.selectedAccountRefs, language],
  );

  const selectedSet = new Set(model.effectiveIds);

  const toggleAccount = (accountId: string) => {
    const next = new Set(model.effectiveIds);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    void pref.update({ selectedAccountRefs: [...next] });
  };

  return (
    <section
      data-testid="accounts-quota-pin-bar"
      className="mb-4 rounded-[12px] px-3.5 py-2.5"
      style={{
        background: 'var(--shell-work, var(--console-card-bg))',
        border: '1px solid var(--shell-hairline, var(--console-border-soft))',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-5 w-5 flex-none items-center justify-center"
            style={{ color: 'var(--shell-ink, var(--cafe-text))' }}
          >
            <QuotaRingIcon summary={model.summary} className="h-4 w-4" />
          </span>
          <span className="text-compact font-medium" style={{ color: 'var(--shell-ink, var(--cafe-text))' }}>
            {t.accountsPageBarTitle}
          </span>
          <span className="text-xs" style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>
            · {t.accountsPageSelectedCount(model.selectedEntries.length)}
          </span>
          {model.allEntries.length > 0 && (
            <button
              type="button"
              data-testid="accounts-quota-pin-choose"
              aria-expanded={choosing}
              onClick={() => setChoosing((prev) => !prev)}
              className="rounded-[6px] px-2 py-0.5 text-xs font-medium"
              style={{
                background: choosing ? 'var(--shell-selected, var(--console-pill-bg))' : 'transparent',
                color: 'var(--shell-body, var(--cafe-text-secondary))',
              }}
            >
              {choosing ? t.doneChoosing : t.chooseAccounts}
            </button>
          )}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={pref.pinned}
          aria-label={t.accountsPageBarTitle}
          data-testid="accounts-quota-pin-toggle"
          disabled={pref.saving}
          onClick={() => void pref.update({ pinned: !pref.pinned })}
          className="cafe-toggle relative inline-flex h-4 w-8 flex-none items-center rounded-full p-0.5 transition-colors"
          style={{
            background: pref.pinned
              ? 'var(--shell-ink, var(--cafe-text))'
              : 'var(--shell-hairline-strong, var(--console-border))',
          }}
        >
          <span
            aria-hidden="true"
            className="block h-3 w-3 rounded-full transition-transform"
            style={{
              background: 'var(--shell-paper, var(--cafe-surface))',
              transform: pref.pinned ? 'translateX(16px)' : 'translateX(0)',
            }}
          />
        </button>
      </div>

      {pref.error && (
        <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--shell-danger, var(--semantic-critical))' }}>
          {t.saveFailed}
        </p>
      )}

      {choosing && model.allEntries.length > 0 && (
        <div
          className="mt-2.5 flex flex-wrap gap-2 pt-2.5"
          style={{ borderTop: '1px solid var(--shell-hairline, var(--console-border-soft))' }}
        >
          {model.allEntries.map((entry) => {
            const checked = selectedSet.has(entry.id);
            return (
              <label
                key={entry.id}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-xs"
                style={{
                  background: checked
                    ? 'var(--shell-selected, var(--console-pill-bg))'
                    : 'var(--shell-paper, var(--cafe-surface))',
                  border: '1px solid var(--shell-hairline, var(--console-border-soft))',
                  color: 'var(--shell-ink, var(--cafe-text))',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleAccount(entry.id)}
                  className="h-3.5 w-3.5 accent-[var(--shell-ink,var(--cafe-text))]"
                />
                <span>
                  <span style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>{entry.provider} · </span>
                  {entry.displayName}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
