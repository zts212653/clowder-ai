'use client';

import type { PawFeelInboxPage } from '@cat-cafe/shared';
import { usePawFeelCopy } from '../paw-feel/paw-feel.shell-copy';
import { type PawFeelUiError, pawFeelUiErrorText } from '../paw-feel/paw-feel-ui-error';
import { PawFeelInboxBundle } from './PawFeelInboxBundle';
import type { DutyReadState } from './usePawFeelDuty';

export function PawFeelInboxHeader({ title, page }: { title: string; page: PawFeelInboxPage | null }) {
  const t = usePawFeelCopy();
  const healthy = page?.coverage?.status === 'healthy';
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-cafe">{title}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-cafe-secondary">{t.inboxDescription}</p>
      </div>
      {page?.coverage ? (
        <span
          className={`inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap text-micro font-semibold ${healthy ? 'text-conn-green-text' : 'text-conn-amber-text'}`}
          title={`coverage · ${page.coverage.status}`}
        >
          <span className={`h-2 w-2 rounded-full ${healthy ? 'bg-conn-green-text' : 'bg-conn-amber-text'}`} />
          {healthy ? t.coverageHealthy : t.coverageDegraded}
        </span>
      ) : null}
    </div>
  );
}

export function PawFeelDutyBanner({
  variant,
  duty,
  page,
}: {
  variant: 'workspace' | 'history';
  duty: DutyReadState;
  page: PawFeelInboxPage | null;
}) {
  const t = usePawFeelCopy();
  if (variant !== 'workspace' || duty.status === 'loading') return null;
  if (duty.status === 'unassigned') {
    return (
      <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
        <div className="font-semibold">{t.unassigned}</div>
        <div className="mt-1 font-medium">
          {t.dutyCounts(
            page?.denominator.reportOccurrences ?? 0,
            page?.denominator.reviewBundles ?? 0,
            page?.counts.overdue ?? 0,
            false,
          )}
        </div>
        <div className="mt-1">
          {t.dutyHintStart}{' '}
          <a className="underline" href="/settings?ops=observability&obs=eval">
            {t.settingsRoute}
          </a>{' '}
          {t.dutyHintEnd}
        </div>
      </div>
    );
  }
  if (duty.status === 'incomplete') {
    return (
      <div className="mt-3 rounded-md border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
        <div className="font-semibold">{t.incomplete}</div>
        <div className="mt-1 font-medium">
          {t.dutyCounts(
            page?.denominator.reportOccurrences ?? 0,
            page?.denominator.reviewBundles ?? 0,
            page?.counts.overdue ?? 0,
            true,
          )}
        </div>
        <div className="mt-1">
          Primary {duty.config.primaryCatId ?? t.notAssigned} / Backup {duty.config.backupCatId ?? t.notAssigned} ·{' '}
          {t.incompleteAssignment}
        </div>
      </div>
    );
  }
  if (duty.status === 'unavailable') {
    return (
      <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
        {t.dutyUnavailable}
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-conn-green-ring pl-2.5 text-xs text-cafe-secondary">
      <span className="font-semibold text-conn-green-text">{t.ready}</span>
      <span className="whitespace-nowrap">Primary @{duty.config.primaryCatId}</span>
      <span className="whitespace-nowrap">Backup @{duty.config.backupCatId}</span>
      <span className="whitespace-nowrap text-cafe-muted">{t.handoffRule}</span>
    </div>
  );
}

export function PawFeelInboxNotices({ page, error }: { page: PawFeelInboxPage | null; error: PawFeelUiError | null }) {
  const t = usePawFeelCopy();
  return (
    <>
      {page?.degraded ? (
        <div className="mt-3 rounded-md border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
          {t.degraded}
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="alert">
          {pawFeelUiErrorText(error, t)}
        </div>
      ) : null}
      {page?.projectionStatus === 'unavailable' ? (
        <div className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="alert">
          {t.ledgerUnavailable}: {page.unavailableReason ?? 'unknown'}
        </div>
      ) : null}
    </>
  );
}

export function PawFeelInboxBody({
  page,
  loading,
  loadingMore,
  onLoadMore,
}: {
  page: PawFeelInboxPage | null;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const t = usePawFeelCopy();
  if (loading && !page) return <p className="mt-3 text-xs text-cafe-muted">{t.loadingInbox}</p>;
  if (page?.projectionStatus === 'available' && page.bundles.length === 0) {
    return <p className="mt-3 rounded-md bg-cafe-surface px-3 py-3 text-xs text-cafe-secondary">{t.empty}</p>;
  }
  return (
    <>
      {page?.bundles.length ? (
        <div
          className="mt-3 divide-y divide-[var(--console-border-soft)] overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)]"
          data-testid="paw-feel-bundle-list"
        >
          {page.bundles.map((bundle) => (
            <PawFeelInboxBundle key={bundle.bundleKey} bundle={bundle} />
          ))}
        </div>
      ) : null}
      {page ? <p className="mt-2 text-micro text-cafe-muted">{t.familiesUnknown}</p> : null}
      {page?.nextCursor ? (
        <button
          type="button"
          disabled={loadingMore}
          onClick={onLoadMore}
          className="mt-3 w-full rounded-md border border-cafe px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-50"
        >
          {loadingMore ? t.loading : t.more}
        </button>
      ) : null}
    </>
  );
}
