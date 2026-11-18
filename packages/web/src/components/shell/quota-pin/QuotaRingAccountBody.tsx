'use client';

import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { quotaPinCopy } from './quota-pin.shell-copy';
import {
  QUOTA_FAMILY_COLOR_TOKEN,
  QUOTA_FAMILY_ORDER,
  type QuotaFamilyId,
  type QuotaRingAccountView,
  type QuotaRingWindowView,
} from './quota-pin-model';

const DANGER_TOKEN = 'var(--quota-bar-danger, var(--shell-danger))';

function tightestStandbyWindow(
  windows: readonly QuotaRingWindowView[],
  family: QuotaFamilyId,
): QuotaRingWindowView | undefined {
  const scopedWindows = family === 'agy' ? windows.filter((w) => w.poolId === 'agy-gemini') : windows;
  const percentWindows = scopedWindows.filter(
    (w): w is QuotaRingWindowView & { remainingPercent: number } =>
      w.kind === 'percent' && w.remainingPercent !== undefined,
  );
  const nonElapsed = percentWindows.filter((w) => !w.elapsed);
  const pool = nonElapsed.length > 0 ? nonElapsed : percentWindows;
  if (pool.length === 0) return scopedWindows[0];
  return pool.reduce((min, cur) => (cur.remainingPercent < min.remainingPercent ? cur : min));
}

function activeBadgeLabel(entry: QuotaRingAccountView, t: (typeof quotaPinCopy)['zh']): string {
  return entry.inUse || entry.activeMemberCount === 0 ? t.inUse : t.partialInUse(entry.activeMemberCount);
}

function StandbyAccountRow({
  entry,
  locale,
  t,
  formatReset,
}: {
  entry: QuotaRingAccountView;
  locale: string;
  t: (typeof quotaPinCopy)['zh'];
  formatReset: (win: QuotaRingWindowView) => string;
}) {
  const win = tightestStandbyWindow(entry.windows, entry.family);
  const resetText = win ? formatReset(win) : '';
  const pctText =
    win?.kind === 'percent' && win.remainingPercent !== undefined
      ? t.left(win.remainingPercent.toFixed(0))
      : win?.kind === 'credits'
        ? t.credits((win.creditsValue ?? 0).toLocaleString(locale))
        : t.noReading;
  const valueColor = win?.low ? DANGER_TOKEN : 'var(--shell-body, var(--cafe-text))';

  return (
    <div
      data-quota-account={entry.id}
      data-quota-role="standby"
      className="flex items-baseline justify-between gap-2 pt-1 text-xs"
      style={{ borderTop: '1px dashed var(--shell-hairline, var(--console-border-soft))' }}
    >
      <span className="min-w-0 truncate" style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>
        {entry.displayName}
      </span>
      <span className="flex-none tabular-nums" style={{ color: valueColor }}>
        {win?.stale ? `${t.stale} · ` : ''}
        {pctText}
        {resetText ? ` · ${resetText}` : ''}
      </span>
    </div>
  );
}

function ActiveWindowItem({
  accountName,
  win,
  familyColor,
  locale,
  t,
  formatDate,
  formatReset,
}: {
  accountName: string;
  win: QuotaRingWindowView;
  familyColor: string;
  locale: string;
  t: (typeof quotaPinCopy)['zh'];
  formatDate: (ms: number) => string;
  formatReset: (win: QuotaRingWindowView) => string;
}) {
  const resetLabel = formatReset(win);
  const barColor = win.low ? DANGER_TOKEN : familyColor;
  const valueLabel =
    win.kind === 'credits'
      ? t.credits((win.creditsValue ?? 0).toLocaleString(locale))
      : t.left((win.remainingPercent ?? 0).toFixed(0));
  const limitSuffix = win.low ? ` · ${win.exhausted ? t.usedUp : t.nearLimit}` : '';

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate" style={{ color: 'var(--shell-body, var(--cafe-text))' }}>
          {win.label}
        </span>
        <span
          className="flex-none font-medium tabular-nums"
          style={{ color: win.low ? DANGER_TOKEN : 'var(--shell-ink, var(--cafe-text))' }}
        >
          {valueLabel}
          {limitSuffix}
        </span>
      </div>
      {win.kind === 'percent' && win.remainingPercent !== undefined && (
        <span
          role="meter"
          aria-label={`${accountName} ${win.label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(win.remainingPercent)}
          aria-valuetext={t.left(win.remainingPercent.toFixed(0))}
          className="block h-1 w-full overflow-hidden rounded-full"
          style={{ background: 'var(--shell-hairline-strong, var(--console-border-soft))' }}
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${Math.max(0, Math.min(100, win.remainingPercent))}%`,
              background: barColor,
            }}
          />
        </span>
      )}
      <div
        className="flex flex-wrap items-center gap-x-1.5 text-label"
        style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}
      >
        {resetLabel && (
          <>
            <span>{resetLabel}</span>
            <span>·</span>
          </>
        )}
        <span>
          {win.stale ? `${t.stale} · ` : ''}
          {t.observed(formatDate(win.observedAt))}
        </span>
      </div>
    </div>
  );
}

export function QuotaRingAccountBody({
  choosing,
  allEntries,
  effectiveIds,
  selectedEntries,
  onToggleAccount,
}: {
  choosing: boolean;
  allEntries: readonly QuotaRingAccountView[];
  effectiveIds: readonly string[];
  selectedEntries: readonly QuotaRingAccountView[];
  onToggleAccount: (accountId: string) => void;
}) {
  const t = useShellCopy(quotaPinCopy);
  const language = useShellLanguage();
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const selectedSet = new Set(effectiveIds);

  const familyGroupTitle: Record<QuotaFamilyId, string> = {
    claude: t.familyGroupClaude,
    codex: t.familyGroupCodex,
    agy: t.familyGroupAgy,
    kimi: t.familyGroupKimi,
  };

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const formatReset = (win: QuotaRingWindowView) =>
    win.elapsed
      ? t.resetElapsed
      : win.resetsAtMs !== undefined
        ? t.resets(formatDate(win.resetsAtMs))
        : (win.resetsText ?? '');

  if (choosing) {
    if (allEntries.length === 0) {
      return (
        <p className="px-3.5 py-4 text-xs" style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>
          {t.noOauthAccounts}
        </p>
      );
    }
    return (
      <div className="p-2">
        <ul
          data-chat-background-surface="group"
          className="divide-y overflow-hidden rounded-[10px] border"
          style={{
            background: 'var(--shell-group, var(--cafe-surface-elevated))',
            borderColor: 'var(--shell-hairline, var(--console-border-soft))',
          }}
        >
          {allEntries.map((entry) => (
            <li key={entry.id}>
              <label className="shell-nav-row flex cursor-pointer items-center justify-between gap-2.5 px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(entry.id)}
                    onChange={() => onToggleAccount(entry.id)}
                    data-testid={`quota-ring-check-${entry.id}`}
                    className="h-3.5 w-3.5 flex-none accent-[var(--shell-ink,var(--cafe-text))]"
                  />
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 flex-none rounded-full"
                    style={{ background: QUOTA_FAMILY_COLOR_TOKEN[entry.family] }}
                  />
                  <span className="truncate text-compact" style={{ color: 'var(--shell-ink, var(--cafe-text))' }}>
                    <span style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>{entry.provider} · </span>
                    {entry.displayName}
                  </span>
                </span>
                {entry.isActiveForFamily && (
                  <span
                    className="flex-none rounded-full px-2 py-0.5 text-label font-medium"
                    style={{
                      background: 'var(--shell-primary-soft, var(--semantic-spotlight-surface))',
                      color: 'var(--shell-primary-active, var(--cafe-accent))',
                    }}
                  >
                    {activeBadgeLabel(entry, t)}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (selectedEntries.length === 0) {
    return (
      <p className="px-3.5 py-4 text-xs" style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>
        {t.noAccountsSelected}
      </p>
    );
  }

  const familyGroups = QUOTA_FAMILY_ORDER.flatMap((family) => {
    const entries = selectedEntries
      .filter((entry) => entry.family === family)
      .sort((a, b) => Number(b.isActiveForFamily) - Number(a.isActiveForFamily));
    return entries.length > 0 ? [{ family, entries }] : [];
  });

  return (
    <div className="space-y-2 p-2">
      {familyGroups.map((group) => {
        const familyColor = QUOTA_FAMILY_COLOR_TOKEN[group.family];
        return (
          <section
            key={group.family}
            data-quota-family={group.family}
            data-chat-background-surface="group"
            className="rounded-[10px] border px-3 py-2.5"
            style={{
              background: 'var(--shell-group, var(--cafe-surface-elevated))',
              borderColor: 'var(--shell-hairline, var(--console-border-soft))',
            }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: familyColor }} />
              <span
                className="text-label font-semibold"
                style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}
              >
                {familyGroupTitle[group.family]}
              </span>
            </div>

            <div className="space-y-2">
              {group.entries.map((entry) =>
                !entry.isActiveForFamily ? (
                  <StandbyAccountRow key={entry.id} entry={entry} locale={locale} t={t} formatReset={formatReset} />
                ) : (
                  <div key={entry.id} data-quota-account={entry.id} data-quota-role="active">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="min-w-0 truncate text-compact font-medium"
                        style={{ color: 'var(--shell-ink, var(--cafe-text))' }}
                      >
                        {entry.displayName}
                      </span>
                      <span
                        className="flex-none rounded-full px-2 py-0.5 text-label font-medium"
                        style={{
                          background: 'var(--shell-primary-soft, var(--semantic-spotlight-surface))',
                          color: 'var(--shell-primary-active, var(--cafe-accent))',
                        }}
                      >
                        {activeBadgeLabel(entry, t)}
                      </span>
                    </div>

                    {entry.windows.length === 0 ? (
                      <p className="mt-1 text-xs" style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}>
                        {t.noReading}
                      </p>
                    ) : (
                      <div className="mt-1.5 space-y-2">
                        {entry.windows.map((win) => (
                          <ActiveWindowItem
                            key={win.id}
                            accountName={entry.displayName}
                            win={win}
                            familyColor={familyColor}
                            locale={locale}
                            t={t}
                            formatDate={formatDate}
                            formatReset={formatReset}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
