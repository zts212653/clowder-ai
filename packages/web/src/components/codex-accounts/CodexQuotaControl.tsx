'use client';
import type { AccountQuotaObservation, CodexAccountIdentity } from '@cat-cafe/shared';
import { useEffect } from 'react';
import { AppTooltip } from '../AppTooltip';
import { accountMessage } from '../accounts/account-message';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { QuotaQueryFeedback, quotaQueryTime } from './QuotaQueryFeedback';
import { quotaCopy } from './quota.shell-copy';
import { remainingQuota as remaining } from './quota-state';
import { useAccountQuota } from './useAccountQuota';
import './codex-quota.css';

type QuotaItem = AccountQuotaObservation['items'][number];
function windowLabel(label: string, language: 'zh' | 'en') {
  const weekly = /^(.*?)(?:每周使用限额|Weekly usage limit)$/i.exec(label);
  if (weekly) return `${weekly[1]}${language === 'zh' ? '本周' : 'Week'}`;
  const hours = /^(.*?)(\d+)小时使用限额$/.exec(label);
  if (hours) return `${hours[1]}${hours[2]}${language === 'zh' ? ' 小时' : ' hours'}`;
  return accountMessage(label, language);
}
export function CodexQuotaControl(props: {
  accountRef: string;
  observation?: AccountQuotaObservation;
  reload: () => Promise<void>;
  managed?: boolean;
  identity?: CodexAccountIdentity;
  allowReading?: boolean;
  inUse?: boolean;
  switchSuggestion?: { name: string; left: number };
  onRelogin?: () => void;
  onObservation?: (observation: AccountQuotaObservation | undefined) => void;
}) {
  const t = useShellCopy(quotaCopy);
  const language = useShellLanguage();
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const { observation, reading, busy, automatic, identityChanged, query } = useAccountQuota(props);
  const { onObservation } = props;
  useEffect(() => {
    onObservation?.(observation);
  }, [onObservation, observation]);
  const good = !!reading?.items.length;
  const items = good ? reading.items : [];
  const tightest = items.reduce((best, item, index) => (remaining(item) < remaining(items[best]) ? index : best), 0);
  const updated = reading ? quotaQueryTime(reading.observedAt, language) : '';
  const failure = observation?.status === 'unavailable' ? observation : undefined;
  const label = good ? t.refresh : failure ? t.retry : t.check;
  const resetLabel = (item: QuotaItem) => {
    const delta = item.resetsAt ? Date.parse(item.resetsAt) - Date.now() : NaN;
    if (!Number.isFinite(delta)) return item.resetsText ? accountMessage(item.resetsText, language) : '';
    if (delta <= 0) return t.resetDue;
    const unit = delta >= 86400000 ? 'day' : delta >= 3600000 ? 'hour' : 'minute';
    const amount = Math.ceil(delta / (unit === 'day' ? 86400000 : unit === 'hour' ? 3600000 : 60000));
    return t.resetIn(new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(amount, unit));
  };
  if (!good && observation?.status === 'unsupported')
    return <span className="account-quota-unavailable">{t.unsupported}</span>;
  return (
    <div className="account-quota" aria-busy={busy}>
      <div className="account-quota-main">
        {good && (
          <div className="account-quota-windows">
            {items.map((item, index) => {
              const value = remaining(item);
              const reset = resetLabel(item);
              const name = windowLabel(item.label, language);
              return (
                <div
                  className="account-quota-window"
                  data-tightest={index === tightest}
                  data-low={value < 20}
                  key={`${item.poolId ?? ''}:${item.label}`}
                >
                  <div className="account-quota-summary">
                    <AppTooltip label={accountMessage(item.label, language)} intent="content">
                      <button type="button" className="account-quota-label">
                        {name}
                      </button>
                    </AppTooltip>
                    <span className="account-quota-value">{t.left(value.toFixed(0))}</span>
                    {value < 20 && <span className="account-quota-warning">{t.nearLimit}</span>}
                  </div>
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
                  <AppTooltip
                    label={
                      item.resetsAt && Number.isFinite(Date.parse(item.resetsAt))
                        ? new Date(item.resetsAt).toLocaleString(locale)
                        : reset || t.resetUnknown
                    }
                    intent="content"
                  >
                    <button type="button" className="account-quota-reset">
                      {reset}
                    </button>
                  </AppTooltip>
                </div>
              );
            })}
          </div>
        )}
        {(!failure || good) && (
          <AppTooltip label={good ? `${t.refresh} · ${t.updated(updated)}` : label}>
            <button
              type="button"
              className={good ? 'account-quota-refresh' : 'account-button account-quota-query'}
              aria-label={good ? t.refresh : undefined}
              disabled={busy}
              onClick={() => void query()}
            >
              <svg
                className={busy ? 'account-quota-spinning' : undefined}
                aria-hidden="true"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7M20 12l-3-5" />
              </svg>
              {!good && (busy ? t.querying : label)}
            </button>
          </AppTooltip>
        )}
      </div>
      {good && props.inUse && remaining(items[tightest]) < 20 && (
        <p className="account-quota-switch-hint">
          {remaining(items[tightest]) === 0 ? t.usedUp : t.nearLimit} ·{' '}
          {props.switchSuggestion
            ? t.switchHint(props.switchSuggestion.name, props.switchSuggestion.left.toFixed(0))
            : t.noNextAccount}
        </p>
      )}
      {identityChanged && <small className="account-quota-error">{t.identityChanged}</small>}
      {automatic ? (
        <p className="account-quota-renewed" role="status">
          {t.renewed}
        </p>
      ) : (
        failure && (
          <QuotaQueryFeedback
            observation={failure}
            readingAt={reading?.observedAt}
            busy={busy}
            query={() => void query()}
            onRelogin={props.onRelogin}
            inUse={props.inUse}
          />
        )
      )}
    </div>
  );
}
