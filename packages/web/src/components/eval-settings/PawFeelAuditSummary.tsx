'use client';

import type { PawFeelInboxPage } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

function isPage(value: unknown): value is PawFeelInboxPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PawFeelInboxPage>;
  return (
    candidate.projectionStatus === 'available' &&
    typeof candidate.denominator === 'object' &&
    typeof candidate.counts === 'object'
  );
}

export function PawFeelAuditSummary() {
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
    <section className="rounded-lg border border-cafe bg-cafe-surface p-3" aria-label="爪感差审计摘要">
      <h3 className="text-sm font-semibold text-cafe">紧凑审计</h3>
      {page ? (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <AuditCount label="报告" value={page.denominator.reportOccurrences} />
          <AuditCount label="审阅包" value={page.denominator.reviewBundles} />
          <AuditCount label="歧义 / 污染" value={page.denominator.ambiguousOrContaminated} />
          <AuditCount label="72h+" value={page.counts.overdue} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-cafe-muted">
          {unavailable ? '审计摘要暂不可读；不会显示空成功。' : '读取审计摘要…'}
        </p>
      )}
      <p className="mt-2 text-xs text-cafe-secondary">
        完整审阅只在 Workspace → 评估进行；Settings 不复制第二个历史 workbench。{' '}
        <a className="font-medium hover:underline" href="/thread/thread_eval_friction">
          打开稳定责任线程
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
