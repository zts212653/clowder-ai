import type { RecallLedger } from './recall-page-types';
import type { TasteBrowse } from './taste-types';
import type { MemoryRead } from './use-memory-read';

export function MemoryRecallStats({
  days,
  ledger,
  taste,
}: {
  days: number;
  ledger: MemoryRead<RecallLedger>;
  taste: MemoryRead<TasteBrowse>;
}) {
  const counts = (source: 'pull' | 'push') =>
    ledger.data?.rows
      .filter((row) => row.source === source)
      .reduce(
        (total, row) => ({ presented: total.presented + row.presented, inspected: total.inspected + row.inspected }),
        { presented: 0, inspected: 0 },
      );
  const entries = taste.data?.entries ?? [];
  const named = entries.reduce(
    (sum, entry) => {
      const counts = entry.recall?.namedDelivery?.counts;
      return {
        presented: sum.presented + (counts?.presented ?? 0),
        drilled: sum.drilled + (counts?.drilled ?? 0),
        applied: sum.applied + (counts?.applied ?? 0),
        dismissed: sum.dismissed + (counts?.dismissed ?? 0),
      };
    },
    { presented: 0, drilled: 0, applied: 0, dismissed: 0 },
  );
  const partial = taste.data?.readStatus === 'partial' || entries.some((entry) => !entry.recall);
  const unreported = named.presented - named.applied - named.dismissed;
  const hints = taste.data?.dimensionHints;
  return (
    <section className="grid gap-3 md:grid-cols-3" aria-label="召回统计">
      {(['pull', 'push'] as const).map((source) => (
        <article key={source} className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
          <p className="text-compact font-medium">
            {source === 'pull' ? '猫发起的检索' : '通用上下文递送'}
            <span className="ml-2 text-xs font-normal text-cafe-muted">近 {days} 天</span>
          </p>
          {ledger.loading ? (
            <output className="mt-3 block text-sm text-cafe-muted">正在读取统计…</output>
          ) : ledger.error ? (
            <p role="alert" className="mt-3 text-sm">
              暂时读不到统计
              <button type="button" onClick={ledger.retry} className="ml-2 text-cafe-accent underline">
                重试
              </button>
            </p>
          ) : (
            <>
              <p className="mt-3 text-display-sm">
                {counts(source)?.presented}
                <span className="ml-2 text-xs text-cafe-muted">次</span>
              </p>
              <p className="mt-2 text-xs text-cafe-muted">
                {source === 'pull' ? `之后有读取 ${counts(source)?.inspected} 次` : '开场、冷启动时系统补给猫的上下文'}
              </p>
              {source === 'pull' && (
                <p className="mt-2 text-xs text-cafe-muted">只算同一次回复里、检索后不久读到结果的情况，可能漏算。</p>
              )}
            </>
          )}
        </article>
      ))}
      <article className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
        <p className="text-compact font-medium">
          品味精确点名<span className="ml-2 text-xs font-normal text-cafe-muted">全部时间</span>
        </p>
        {taste.loading ? (
          <output className="mt-3 block text-sm text-cafe-muted">正在读取统计…</output>
        ) : taste.error ? (
          <p role="alert" className="mt-3 text-sm">
            暂时读不到统计
            <button type="button" onClick={taste.retry} className="ml-2 text-cafe-accent underline">
              重试
            </button>
          </p>
        ) : (
          <>
            <p className="mt-3 text-display-sm">
              {partial ? '部分读到' : named.presented}
              <span className="ml-2 text-xs text-cafe-muted">{partial ? `${named.presented} 次已核对` : '次'}</span>
            </p>
            <p className="mt-2 text-xs text-cafe-muted">
              {partial && '已核对：'}点开 {named.drilled} · 采用 {named.applied} · 明确不用 {named.dismissed} ·{' '}
              {unreported >= 0 ? `其余 ${unreported} 次未回报` : '未回报次数暂时读不到'}
            </p>
            <p className="mt-2 text-xs text-cafe-muted">
              品味维度提示 · 全部时间：
              {hints ? (hints.presented === 0 ? '没有记录' : `${hints.presented} 次`) : '暂时读不到'}
            </p>
          </>
        )}
      </article>
    </section>
  );
}
