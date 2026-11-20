'use client';
import { claudeQuotaWindows } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { AccountRequestError, accountRequest } from '../codex-accounts/account-request';
import type { ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { claudeQuotaCopy } from './claude-quota.shell-copy';
import '../codex-accounts/codex-quota.css';
import './claude-quota.css';

export function ClaudeQuotaControl({
  account,
  reload,
}: {
  account: Pick<ProfileItem, 'id' | 'claudeQuota'>;
  reload: () => Promise<void>;
}) {
  const t = useShellCopy(claudeQuotaCopy);
  const language = useShellLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  // A directory read replaces the account row even when both logins have no quota.
  const latestAccount = useRef(account);
  latestAccount.current = account;
  const windows = claudeQuotaWindows(account.claudeQuota?.samples ?? {});
  const resetTimes = windows.flatMap((window) =>
    window.resetsAt && window.resetsAt * 1000 > now ? [window.resetsAt * 1000] : [],
  );
  const nextTick = Math.min(60000, ...resetTimes.map((time) => time - now + 1));
  const tickAt = now + nextTick;
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, tickAt - Date.now()));
    return () => clearTimeout(timer);
  }, [tickAt]);
  const date = (value: number) =>
    new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  async function query() {
    setBusy(true);
    setError('');
    try {
      await accountRequest(`/api/accounts/${encodeURIComponent(account.id)}/claude/quota`, {});
    } catch (e) {
      if (latestAccount.current !== account) return;
      setError(
        e instanceof AccountRequestError && e.status === 409
          ? t.changed
          : e instanceof Error && e.message === 'claude_quota_owner_unknown'
            ? t.ownerUnknown
            : t.unavailable,
      );
    } finally {
      // The directory read checks the current login after the query finishes.
      await reload().catch(() => undefined);
      setNow(Date.now());
      setBusy(false);
    }
  }
  return (
    <div className="account-quota claude-quota" aria-busy={busy}>
      <div className="account-quota-windows">
        {!windows.length && <small>{t.unknown}</small>}
        {windows.map((window) => {
          const key = window.key;
          const name =
            key === 'five_hour'
              ? t.fiveHour
              : key === 'seven_day'
                ? t.weekly
                : key === 'seven_day_overage_included' && /fable/i.test(window.model)
                  ? t.fable
                  : `${key} (${window.model})`;
          const value = window.utilization === undefined ? undefined : (1 - window.utilization) * 100;
          const elapsed = window.resetsAt !== undefined && now >= window.resetsAt * 1000;
          const stale = elapsed || now - window.observedAt >= 600000 || window.observedAt > now;
          return (
            <div className="claude-quota-reading" key={`${window.model}:${key}`} data-stale={stale}>
              <div className="account-quota-window" data-low={value !== undefined && value < 20}>
                <div className="account-quota-summary">
                  <span className="account-quota-label" title={`${key} · ${window.model}`}>
                    {name}
                  </span>
                  <span className="account-quota-value">{value === undefined ? '—' : t.left(value.toFixed(0))}</span>
                </div>
                {value !== undefined && (
                  <span
                    role="meter"
                    aria-label={name}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={value}
                    aria-valuetext={t.left(value.toFixed(0))}
                    className="account-quota-meter"
                  >
                    <span style={{ width: `${value}%` }} />
                  </span>
                )}
                <span className="account-quota-reset">
                  {elapsed
                    ? t.resetElapsed
                    : window.resetsAt === undefined
                      ? t.resetUnknown
                      : t.resets(date(window.resetsAt * 1000))}
                </span>
              </div>
              <small className="claude-quota-time">
                {stale ? `${t.stale} · ` : ''}
                {t.observed(date(window.observedAt))}
              </small>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="account-button account-quota-query"
        title={t.hint}
        disabled={busy}
        onClick={() => void query()}
      >
        {busy ? t.reading : t.check}
      </button>
      {error && (
        <small role="alert" className="account-quota-error">
          {error}
        </small>
      )}
    </div>
  );
}
