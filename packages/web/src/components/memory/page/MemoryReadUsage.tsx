import { memoryReadUsageSchema, type MemoryReadUsage as Usage } from '@cat-cafe/shared';
import Link from 'next/link';
import { useCallback } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

const countText = (n: number, unattributed: number) =>
  n > 0 ? `${n} 次` : unattributed > 0 ? '有记录，消费猫无法核实' : '这条渠道没有记录';
export function MemoryReadUsage({ endpoint, anchor }: { endpoint: string; anchor: string }) {
  const validate = useCallback(
    (value: unknown): value is Usage => {
      const parsed = memoryReadUsageSchema.safeParse(value);
      return (
        parsed.success &&
        parsed.data.sourceAnchor === anchor &&
        parsed.data.revision === new URLSearchParams(endpoint.split('?')[1]).get('revision')
      );
    },
    [endpoint, anchor],
  );
  const read = useMemoryRead(endpoint, validate);
  const { cats } = useCatData();
  if (read.loading) return <p className="text-compact text-cafe-muted">正在读取被猫翻到的次数…</p>;
  if (read.error || !read.data)
    return (
      <p className="text-compact text-cafe-muted">
        次数暂时读不到 ·{' '}
        <button type="button" className="shell-focusable underline" onClick={read.retry}>
          重读次数
        </button>
      </p>
    );
  const { currentVersion, allVersions, recordedUnattributed, recent, directReadRecordedSince } = read.data;
  return (
    <div className="space-y-2 text-compact">
      <p>当前版本的读取记录</p>
      <p>
        {currentVersion.read > 0
          ? `被猫翻到 ${currentVersion.read} 次`
          : `被猫翻到 · ${countText(0, recordedUnattributed.currentVersion.read)}`}
      </p>
      <p className="text-xs text-cafe-muted">
        次数只计可核实归属的读取，不代表实际采用。未计入次数未知，历史记录不完整。
      </p>
      {recordedUnattributed.allVersions.read > 0 && (
        <p className="text-xs text-cafe-muted">
          现有记录中，当前版本有 {recordedUnattributed.currentVersion.read} 次、之前版本有{' '}
          {recordedUnattributed.allVersions.read - recordedUnattributed.currentVersion.read}{' '}
          次消费猫无法核实，未计入已核实次数。
        </p>
      )}
      <details className="space-y-2 text-xs text-cafe-muted">
        <summary className="shell-focusable cursor-pointer">统计范围与原使用记录</summary>
        <p>
          猫主动读取：{countText(currentVersion.directRead, recordedUnattributed.currentVersion.directRead)}（
          {recordedUnattributed.currentVersion.directRead} 次未核实归属） · 点名记忆点开：
          {countText(currentVersion.cueDrill, recordedUnattributed.currentVersion.cueDrill)}（
          {recordedUnattributed.currentVersion.cueDrill} 次未核实归属）。
        </p>
        <p>
          直接读取从 {formatMemoryDate(directReadRecordedSince)}{' '}
          起留存。列表返回的完整条目和分段读到的内容按每次读取计；只有导航的占位、失败和主人打开网页不计入。
        </p>
        <p>之前版本：被猫翻到 {allVersions.read - currentVersion.read} 次。</p>
        {recent.length > 0 && (
          <ul className="space-y-2">
            {recent.map((row) => {
              const cat = cats.find((item) => item.id === row.catId);
              const catName = cat?.nickname || cat?.displayName;
              return (
                <li key={row.eventId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {formatMemoryDate(row.occurredAt)}
                    {catName ? ` · ${catName}` : ''} · {row.kind === 'direct_read' ? '主动读取' : '点名记忆点开'}
                  </span>
                  {row.threadId && (
                    <Link
                      className="shell-focusable text-cafe-accent underline"
                      href={`/thread/${encodeURIComponent(row.threadId)}`}
                    >
                      查看对话
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </details>
    </div>
  );
}
