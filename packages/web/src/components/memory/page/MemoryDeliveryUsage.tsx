import type { RecallResolverFamily } from '@cat-cafe/shared';
import { MemoryReadUsage } from './MemoryReadUsage';
import { memoryObject } from './owner-memory-read';
import { useMemoryRead } from './use-memory-read';

interface Summary {
  counts: { presented: number; drilled: number; applied: number; dismissed: number };
}
function isSummary(value: unknown): value is Summary {
  return (
    memoryObject(value) &&
    memoryObject(value.counts) &&
    ['presented', 'drilled', 'applied', 'dismissed'].every((key) => {
      const n = (value.counts as Record<string, unknown>)[key];
      return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    })
  );
}
export function MemoryDeliveryUsage({
  family,
  anchor,
  usageEndpoint,
}: {
  family: RecallResolverFamily;
  anchor: string;
  usageEndpoint?: string;
}) {
  const read = useMemoryRead(
    `/api/memory/cues/source-summary?${new URLSearchParams({ resolverFamily: family, sourceAnchor: anchor })}`,
    isSummary,
  );
  const counts = read.data?.counts;
  return (
    <section className="space-y-3 border-t border-cafe-subtle pt-4" aria-label="使用记录">
      <h4 className="text-compact text-cafe-muted">使用记录</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-compact">
        <dt className="text-cafe-muted">点名递送</dt>
        <dd>
          {read.loading ? (
            '正在读取次数…'
          ) : read.error || !counts ? (
            <>
              <span>还没接进来</span> ·{' '}
              <button type="button" className="underline" onClick={read.retry}>
                重读次数
              </button>
            </>
          ) : counts.presented === 0 ? (
            '这条渠道没有记录'
          ) : (
            `${counts.presented} 次 · 点开 ${counts.drilled} · 采用 ${counts.applied} · 明确不用 ${counts.dismissed}`
          )}
        </dd>
        {!usageEndpoint && (
          <>
            <dt className="text-cafe-muted">被猫翻到</dt>
            <dd>还没接进来</dd>
          </>
        )}
      </dl>
      {usageEndpoint && <MemoryReadUsage endpoint={usageEndpoint} anchor={anchor} />}
    </section>
  );
}
