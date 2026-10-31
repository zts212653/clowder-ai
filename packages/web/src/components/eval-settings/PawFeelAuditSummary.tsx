'use client';

import type { PawFeelInboxPage } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { usePawFeelCopy } from '../paw-feel/paw-feel.shell-copy';

function isPage(value: unknown): value is PawFeelInboxPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PawFeelInboxPage>;
  return (
    candidate.projectionStatus === 'available' &&
    typeof candidate.denominator === 'object' &&
    typeof candidate.counts === 'object' &&
    typeof candidate.issueCounts === 'object'
  );
}

export function PawFeelAuditSummary() {
  const t = usePawFeelCopy();
  const [page, setPage] = useState<PawFeelInboxPage | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void apiFetch('/api/paw-feel/inbox?limit=1&sort=newest')
      .then(async (response) => {
        const payload: unknown = response.ok ? await response.json() : null;
        if (!active) return;
        if (isPage(payload)) setPage(payload);
        else setUnavailable(true);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface p-3" aria-label={t.auditLabel}>
      <h3 className="text-sm font-semibold text-cafe">{t.auditTitle}</h3>
      {page ? (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <AuditCount label={t.auditReports} value={page.denominator.reportOccurrences} />
          <AuditCount label={t.bundles} value={page.denominator.reviewBundles} />
          <AuditCount label={t.ambiguous} value={page.denominator.ambiguousOrContaminated} />
          <AuditCount label={t.overdue} value={page.issueCounts.overdue} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-cafe-muted">{unavailable ? t.auditUnavailable : t.loadingAudit}</p>
      )}
      <p className="mt-2 text-xs text-cafe-secondary">
        {t.auditHint}{' '}
        <a className="font-medium hover:underline" href="/thread/thread_eval_friction">
          {t.openThread}
        </a>
      </p>
    </section>
  );
}

function AuditCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-cafe-surface-elevated px-2 py-2">
      <div className="text-micro text-cafe-muted">{label}</div>
      <div className="mt-0.5 font-semibold text-cafe">{value}</div>
    </div>
  );
}
