import Link from 'next/link';
import { tasteTime } from './taste-format';
import type { TasteLatest, TasteMemory } from './taste-types';

function LatestRecall({ latest }: { latest: TasteLatest | null | undefined }) {
  if (!latest) return null;
  const statuses: Record<string, string> = {
    applied: '采用',
    dismissed: '明确不用',
    drilled: '点开看过',
    presented_unreported: '已递送·未回报',
    invalidated: '已失效',
    read: '之后读到',
    not_read: '之后没看到读取',
  };
  return (
    <p className="mt-1 w-full text-xs text-cafe-muted">
      最近一次：
      {tasteTime(latest.at)} · {Object.hasOwn(statuses, latest.outcome) ? statuses[latest.outcome] : '状态暂时读不到'} ·{' '}
      {latest.title && latest.threadId ? (
        <Link className="text-cafe-accent underline" href={`/thread/${encodeURIComponent(latest.threadId)}`}>
          {latest.title}
        </Link>
      ) : (
        '来源对话暂时读不到'
      )}
    </p>
  );
}

export function MemoryTasteRecall({ entry }: { entry: TasteMemory }) {
  const recall = entry.recall;
  if (!recall) return <p className="text-compact text-cafe-muted">暂时读不到被想起记录</p>;
  const named = recall.namedDelivery?.counts;
  const search = recall.search;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-compact">
      <dt className="text-cafe-muted">系统点名递送</dt>
      <dd className="flex flex-wrap gap-x-2 gap-y-1">
        {named && Object.values(named).some((count) => count > 0) ? (
          <>
            <span className="whitespace-nowrap">已递送 {named.presented} 次</span>
            <span className="whitespace-nowrap">点开看过 {named.drilled} 次</span>
            <span className="whitespace-nowrap">采用 {named.applied} 次</span>
            <span className="whitespace-nowrap">明确不用 {named.dismissed} 次</span>
            <span className="whitespace-nowrap">
              {Math.max(0, named.presented - named.applied - named.dismissed)} 次未回报
            </span>
          </>
        ) : (
          '这条渠道没有记录'
        )}
        <LatestRecall latest={recall.namedDelivery?.latest} />
      </dd>
      <dt className="text-cafe-muted">维度提示</dt>
      <dd>只记录在维度上，没有算成这条品味被想起</dd>
      <dt className="text-cafe-muted">猫主动检索</dt>
      <dd>
        {search && (search.hits > 0 || search.opened > 0 || search.unverified > 0) ? (
          <>
            {search.hits > 0 || search.opened > 0 ? (
              <span className="inline-block">
                命中 {search.hits} 次 · 之后读了 {search.opened} 条
              </span>
            ) : (
              <span>没有可核实归属的检索记录</span>
            )}
            {search.unverified > 0 && (
              <p className="mt-1 text-xs text-cafe-muted">另有 {search.unverified} 次归属没核实，没有算进次数</p>
            )}
          </>
        ) : (
          '这条渠道没有记录'
        )}
        <LatestRecall latest={search?.latest} />
      </dd>
    </dl>
  );
}
