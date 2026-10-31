'use client';

import { catColorVar } from '@/lib/cat-slug';
import type { ContextHealthData } from '@/stores/chat-types';
import { useShellCopy } from '../shell/shell-copy';
import { formatTokenCount } from '../status-helpers';
import { sessionRowCopy } from './session-row.shell-copy';

/** Keep the existing measurement and unit. Token totals are never a context percentage. */
export function SessionContextV2({ catId, health }: { catId: string; health?: ContextHealthData }) {
  const t = useShellCopy(sessionRowCopy);
  if (!health || !Number.isFinite(health.usedTokens) || health.usedTokens < 0) {
    return <p className="status-v2-muted">{t.contextUnknown}</p>;
  }
  if (!Number.isFinite(health.windowTokens) || health.windowTokens <= 0) {
    return <p className="status-v2-muted">{t.windowUnknown(formatTokenCount(health.usedTokens))}</p>;
  }
  if (!Number.isFinite(health.fillRatio) || health.fillRatio < 0) {
    return <p className="status-v2-muted">{t.contextUnknown}</p>;
  }
  const percent = Math.round(health.fillRatio * 100);
  const nearLimit = health.fillRatio >= 0.8;
  const estimated = health.source === 'approx' || health.usedFrom === 'input' || health.usedFrom === 'total';
  const source =
    health.usedFrom === 'input'
      ? t.inputEstimate
      : health.usedFrom === 'total'
        ? t.totalEstimate
        : estimated
          ? t.estimate
          : t.measured;
  return (
    <div
      className="status-v2-context"
      title={t.measurement(source, formatTokenCount(health.usedTokens), formatTokenCount(health.windowTokens))}
    >
      <div
        role="progressbar"
        aria-label={t.contextUsage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-valuetext={`${estimated ? t.approximately : ''}${percent}%${nearLimit ? t.nearLimitSuffix : ''}`}
        data-near-limit={nearLimit}
        className="status-v2-meter"
      >
        <span
          style={{
            width: `${Math.min(percent, 100)}%`,
            background: nearLimit ? 'var(--semantic-warning)' : catColorVar(catId, 'primary'),
          }}
        />
      </div>
      <span className="status-v2-muted">
        {estimated ? t.approximately : ''}
        {percent}%
      </span>
      {nearLimit && (
        <span className="status-v2-limit">
          <span className="status-v2-dot" style={{ background: 'var(--semantic-warning)' }} />
          {t.nearLimit}
        </span>
      )}
    </div>
  );
}
