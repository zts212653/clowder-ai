'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface HealthReportData {
  totalDocs: number;
  byKind: Record<string, number>;
  byAuthority: Record<string, number>;
  contradictions: { total: number; unresolved: number };
  staleReview: { warning: number; overdue: number };
  unverified: number;
  backstopRatio: number;
  compressionRatio: number;
  generatedAt: string;
}

export function sortedEntries(data: Record<string, number>): Array<[string, number]> {
  return Object.entries(data).sort((a, b) => b[1] - a[1]);
}

export function computeBarWidth(value: number, max: number): number {
  if (max === 0) return 0;
  return (value / max) * 100;
}

export interface DonutSegment {
  level: string;
  count: number;
  dashLength: number;
  offset: number;
}

export function computeDonutSegments(
  levels: readonly string[],
  byAuthority: Record<string, number>,
  total: number,
  radius: number,
): DonutSegment[] {
  if (total === 0) return [];
  const circumference = 2 * Math.PI * radius;
  const segments: DonutSegment[] = [];
  let cumulative = 0;
  for (const level of levels) {
    const count = byAuthority[level] ?? 0;
    if (count === 0) continue;
    const dashLength = (count / total) * circumference;
    segments.push({ level, count, dashLength, offset: cumulative });
    cumulative += dashLength;
  }
  return segments;
}

export function getActionItems(report: HealthReportData): string[] {
  const items: string[] = [];
  const constitutional = report.byAuthority.constitutional ?? 0;
  if (constitutional === 0 && report.totalDocs > 0) {
    items.push('Run constitutional seeding to promote core rules');
  }
  if (report.contradictions.unresolved > 0) {
    items.push(`${report.contradictions.unresolved} unresolved contradiction(s) need review`);
  }
  if (report.staleReview.overdue > 0) {
    items.push(`${report.staleReview.overdue} document(s) overdue for review`);
  }
  if (report.unverified > 0) {
    items.push(`${report.unverified} document(s) lack verification`);
  }
  return items;
}

const AUTHORITY_LEVELS = ['observed', 'candidate', 'validated', 'constitutional'] as const;
const AUTHORITY_COLORS: Record<string, string> = {
  observed: '#E8C872',
  candidate: '#6B9BD2',
  validated: '#6BAF8D',
  constitutional: '#9B8EC4',
};

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex-1 rounded-xl border border-cafe bg-white p-4">
      <div className="text-xs text-cafe-secondary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-cafe-black">{value}</div>
      <div className="mt-0.5 text-[10px] text-cafe-muted">{sub}</div>
    </div>
  );
}

function DonutRing({ byAuthority, total }: { byAuthority: Record<string, number>; total: number }) {
  const observed = byAuthority.observed ?? 0;
  const pct = total > 0 ? Math.round((observed / total) * 100) : 0;
  const hasMultiple = AUTHORITY_LEVELS.some((l) => l !== 'observed' && (byAuthority[l] ?? 0) > 0);

  return (
    <div className="flex items-center gap-6 rounded-xl border border-cafe bg-white p-5">
      <div className="relative flex h-[100px] w-[100px] items-center justify-center">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="40" fill="none" stroke="#F0EDE6" strokeWidth="16" />
          {hasMultiple ? (
            computeDonutSegments(AUTHORITY_LEVELS, byAuthority, total, 40).map((seg) => {
              const circumference = 2 * Math.PI * 40;
              return (
                <circle
                  key={seg.level}
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke={AUTHORITY_COLORS[seg.level]}
                  strokeWidth="16"
                  strokeDasharray={`${seg.dashLength} ${circumference}`}
                  strokeDashoffset={-seg.offset}
                />
              );
            })
          ) : (
            <circle cx="50" cy="50" r="40" fill="none" stroke="#E8C872" strokeWidth="16" />
          )}
        </svg>
        <span className="absolute text-lg font-bold text-[#7A5C1F]">{pct}%</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {AUTHORITY_LEVELS.map((level) => (
          <div key={level} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: AUTHORITY_COLORS[level] }}
            />
            <span className="text-cafe-secondary">{level}</span>
            <span className="font-medium text-cafe-black">{byAuthority[level] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KindBarChart({ byKind }: { byKind: Record<string, number> }) {
  const entries = sortedEntries(byKind);
  if (entries.length === 0) return null;
  const max = entries[0][1];

  return (
    <div className="rounded-xl border border-cafe bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold text-cafe-black">Knowledge Distribution</h3>
      <div className="flex flex-col gap-2">
        {entries.map(([kind, count]) => (
          <div key={kind} className="flex items-center gap-3">
            <span className="w-20 text-right text-xs text-cafe-secondary">{kind}</span>
            <div className="flex-1">
              <div
                className="h-6 rounded-md bg-[#D4C5A9] transition-all"
                style={{ width: `${computeBarWidth(count, max)}%` }}
              />
            </div>
            <span className="w-16 text-xs font-medium text-cafe-black">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionItems({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="mb-2 text-xs font-semibold text-amber-800">Action Needed</h3>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-xs text-amber-700">
            <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HealthReport() {
  const [report, setReport] = useState<HealthReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    try {
      const res = await apiFetch('/api/f163/health-report');
      if (!res.ok) throw new Error(`Health report fetch failed: ${res.status}`);
      const data = (await res.json()) as HealthReportData;
      setReport(data);
      setError(null);
    } catch {
      setError('Failed to fetch health report');
    }
  }, []);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  if (error) {
    return (
      <div data-testid="health-report" className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-600">{error}</p>
        <button type="button" onClick={fetchReport} className="mt-2 text-xs text-red-700 underline">
          重试
        </button>
      </div>
    );
  }

  if (!report) {
    return (
      <div data-testid="health-report" className="p-4">
        <p className="text-sm text-cafe-secondary">Loading...</p>
      </div>
    );
  }

  const actions = getActionItems(report);

  return (
    <div data-testid="health-report" className="space-y-4">
      <div className="flex gap-3">
        <StatCard
          label="Total Documents"
          value={report.totalDocs.toLocaleString()}
          sub={`across ${Object.keys(report.byKind).length} knowledge types`}
        />
        <StatCard
          label="Contradictions"
          value={String(report.contradictions.unresolved)}
          sub={`${report.contradictions.total} total detected`}
        />
        <StatCard
          label="Stale / Unverified"
          value={`${report.staleReview.overdue} / ${report.unverified}`}
          sub={`${report.staleReview.warning} approaching review`}
        />
      </div>

      <DonutRing byAuthority={report.byAuthority} total={report.totalDocs} />

      <KindBarChart byKind={report.byKind} />

      <ActionItems items={actions} />

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-cafe-muted">Generated {new Date(report.generatedAt).toLocaleString()}</span>
        <button
          type="button"
          onClick={fetchReport}
          className="rounded-lg border border-cafe bg-white px-3 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface"
        >
          刷新
        </button>
      </div>
    </div>
  );
}
