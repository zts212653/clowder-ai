'use client';

import type {
  DispatchExecutionDigest,
  IntentCard,
  ResolutionItem,
  Slice,
  SourceTag,
  TriageBucket,
} from '@cat-cafe/shared';

interface GovernanceHealthProps {
  cards: IntentCard[];
  digests?: DispatchExecutionDigest[];
  resolutions?: ResolutionItem[];
  slices?: Slice[];
}

const BUCKET_ORDER: TriageBucket[] = ['build_now', 'clarify_first', 'validate_first', 'challenge', 'later'];
const BUCKET_LABELS: Record<TriageBucket, string> = {
  build_now: 'Build Now',
  clarify_first: 'Clarify First',
  validate_first: 'Validate First',
  challenge: 'Challenge',
  later: 'Later',
};
const BUCKET_COLORS: Record<TriageBucket, string> = {
  build_now: 'bg-conn-emerald-text',
  clarify_first: 'bg-conn-amber-text',
  validate_first: 'bg-conn-amber-text',
  challenge: 'bg-conn-red-text',
  later: 'bg-cafe-surface-sunken',
};

const SOURCE_TAGS: SourceTag[] = ['Q', 'O', 'D', 'R', 'A'];
const SOURCE_COLORS: Record<SourceTag, string> = {
  Q: 'bg-[var(--color-cafe-accent)]',
  O: 'bg-conn-emerald-text',
  D: 'bg-conn-purple-text',
  R: 'bg-conn-emerald-text',
  A: 'bg-conn-red-text',
};

export function GovernanceHealth({ cards, digests = [], resolutions = [], slices = [] }: GovernanceHealthProps) {
  const total = cards.length;
  const triaged = cards.filter((c) => c.triage).length;
  const bucketCounts = BUCKET_ORDER.map((b) => ({
    bucket: b,
    count: cards.filter((c) => c.triage?.bucket === b).length,
  }));
  const sourceCounts = SOURCE_TAGS.map((t) => ({
    tag: t,
    count: cards.filter((c) => c.sourceTag === t).length,
  }));
  const riskCounts: Record<string, number> = {};
  for (const card of cards) {
    for (const signal of card.riskSignals) {
      riskCounts[signal] = (riskCounts[signal] ?? 0) + 1;
    }
  }
  const topRisks = Object.entries(riskCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Cards" value={`${triaged}/${total}`} sub="triaged" />
        <StatCard label="Build Now" value={String(bucketCounts[0]?.count ?? 0)} sub="ready" />
        <StatCard
          label="Unresolved"
          value={String(
            (bucketCounts.find((b) => b.bucket === 'clarify_first')?.count ?? 0) +
              (bucketCounts.find((b) => b.bucket === 'validate_first')?.count ?? 0),
          )}
          sub="需要确认"
        />
      </div>

      {/* Bucket distribution */}
      <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase text-cafe-muted">Triage Distribution</div>
        {total === 0 ? (
          <div className="text-xs text-cafe-muted">尚无数据</div>
        ) : (
          <>
            <div className="mb-2 flex h-4 overflow-hidden rounded-full">
              {bucketCounts
                .filter((b) => b.count > 0)
                .map((b) => (
                  <div
                    key={b.bucket}
                    className={`${BUCKET_COLORS[b.bucket]}`}
                    style={{ width: `${(b.count / total) * 100}%` }}
                    title={`${BUCKET_LABELS[b.bucket]}: ${b.count}`}
                  />
                ))}
            </div>
            <div className="flex flex-wrap gap-3 text-[10px] text-cafe-secondary">
              {bucketCounts
                .filter((b) => b.count > 0)
                .map((b) => (
                  <span key={b.bucket} className="flex items-center gap-1">
                    <span className={`inline-block h-2 w-2 rounded-full ${BUCKET_COLORS[b.bucket]}`} />
                    {BUCKET_LABELS[b.bucket]}: {b.count}
                  </span>
                ))}
            </div>
          </>
        )}
      </div>

      {/* Source distribution */}
      <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase text-cafe-muted">Source Tag Distribution</div>
        <div className="flex gap-2">
          {sourceCounts
            .filter((s) => s.count > 0)
            .map((s) => (
              <div key={s.tag} className="flex items-center gap-1 text-xs text-cafe-secondary">
                <span className={`inline-block h-2 w-2 rounded-full ${SOURCE_COLORS[s.tag]}`} />
                {s.tag}: {s.count}
              </div>
            ))}
          {sourceCounts.every((s) => s.count === 0) && <div className="text-xs text-cafe-muted">尚无数据</div>}
        </div>
      </div>

      {/* Top risks */}
      {topRisks.length > 0 && (
        <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase text-cafe-muted">Top Risk Signals</div>
          <div className="space-y-1">
            {topRisks.map(([signal, count]) => (
              <div key={signal} className="flex items-center justify-between text-xs">
                <span className="text-cafe-secondary">{signal.replace(/_/g, ' ')}</span>
                <span className="font-medium text-conn-red-text">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dispatch stats (F070 Phase 3c) */}
      {digests.length > 0 && (
        <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase text-cafe-muted">Dispatch Stats</div>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="派遣次数" value={String(digests.length)} sub="total" />
            <StatCard
              label="完成率"
              value={`${Math.round((digests.filter((d) => d.status === 'completed').length / digests.length) * 100)}%`}
              sub={`${digests.filter((d) => d.status === 'completed').length}/${digests.length}`}
            />
            <StatCard
              label="标准达成"
              value={(() => {
                const allResults = digests.flatMap((d) => d.doneWhenResults);
                if (allResults.length === 0) return '—';
                return `${Math.round((allResults.filter((r) => r.met).length / allResults.length) * 100)}%`;
              })()}
              sub="doneWhen"
            />
          </div>
        </div>
      )}

      {/* Resolution progress */}
      {resolutions.length > 0 && (
        <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase text-cafe-muted">Resolution Progress</div>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Open" value={String(resolutions.filter((r) => r.status === 'open').length)} sub="待解决" />
            <StatCard
              label="Answered"
              value={String(resolutions.filter((r) => r.status === 'answered').length)}
              sub="已回答"
            />
            <StatCard
              label="Escalated"
              value={String(resolutions.filter((r) => r.status === 'escalated').length)}
              sub="已升级"
            />
          </div>
        </div>
      )}

      {/* Slice progress */}
      {slices.length > 0 && (
        <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase text-cafe-muted">Slice Progress</div>
          <div className="grid grid-cols-4 gap-3">
            <StatCard
              label="Planned"
              value={String(slices.filter((s) => s.status === 'planned').length)}
              sub="计划中"
            />
            <StatCard
              label="In Progress"
              value={String(slices.filter((s) => s.status === 'in_progress').length)}
              sub="进行中"
            />
            <StatCard
              label="Delivered"
              value={String(slices.filter((s) => s.status === 'delivered').length)}
              sub="已交付"
            />
            <StatCard
              label="Validated"
              value={String(slices.filter((s) => s.status === 'validated').length)}
              sub="已验证"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg bg-[var(--console-field-bg)] p-3 text-center">
      <div className="text-lg font-bold text-cafe">{value}</div>
      <div className="text-[10px] font-medium text-cafe-muted">{label}</div>
      <div className="text-[10px] text-cafe-muted">{sub}</div>
    </div>
  );
}
