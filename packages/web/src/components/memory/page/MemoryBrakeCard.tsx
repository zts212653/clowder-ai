'use client';
import { useRouter } from 'next/navigation';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { type BrakeMessage, brakeExcerpt } from './brake-model';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

interface BrakeSource {
  title: string | null;
  canOpen: boolean;
  threadId?: string;
  messageId?: string;
}

export function MemoryBrakeCard({
  row,
  active,
  onSelect,
  detail = false,
}: {
  row: BrakeMessage;
  active: boolean;
  onSelect: () => void;
  detail?: boolean;
}) {
  const source = useMemoryRead<BrakeSource>(`/api/memory/brakes/${encodeURIComponent(row.sourceEventId)}/source`);
  const { getCatById, isLoading: catsLoading } = useCatData();
  const router = useRouter();
  const title = source.loading
    ? '正在读取来源…'
    : source.error || (source.data !== null && !source.data.canOpen)
      ? '暂时读不到来源对话'
      : source.data?.title || '对话 · 标题没有记录下来';
  const locate = () => {
    const data = source.data;
    if (!data?.canOpen || !data.threadId || !data.messageId) return;
    // We are on a memory page, even if the store still remembers the previous chat.
    handleTeleportEvent({ threadId: data.threadId, messageId: data.messageId }, null, {
      pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
      scrollToMessage,
    });
  };
  return (
    <article
      className={`rounded-xl border bg-[var(--console-card-bg)] p-4 ${active ? 'border-cafe-accent' : 'border-cafe-subtle'}`}
      data-testid="brake-message"
    >
      <button type="button" onClick={onSelect} className="w-full text-left" aria-pressed={active}>
        <div className="flex flex-wrap items-center gap-2 text-compact">
          {row.words.map((word) => (
            <span key={word} className="rounded-md bg-cafe-surface-sunken px-2 py-1 font-medium">
              {word}
            </span>
          ))}
          <span className="text-cafe-muted">对</span>
          {row.cats.map((cat) => {
            const data = getCatById(cat);
            return data ? (
              <span key={cat} className="inline-flex items-center gap-1">
                <CatAvatar catId={cat} size={20} />
                {data.nickname || data.displayName}
              </span>
            ) : (
              <span key={cat} className="text-cafe-muted">
                {catsLoading ? '正在读取猫的名字…' : '猫的名字暂时读不到'}
              </span>
            );
          })}
          <time className="ml-auto text-xs text-cafe-muted">{formatMemoryDate(row.timestamp)}</time>
        </div>
        <p className={`mt-3 whitespace-pre-wrap break-words text-sm leading-[1.55] ${detail ? '' : 'line-clamp-3'}`}>
          {(detail ? row.summary : brakeExcerpt(row.summary, row.words)) || '这条原话没有记录下来'}
        </p>
      </button>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-compact">
        <p className="min-w-0 break-words text-cafe-muted">{title}</p>
        {source.data?.canOpen && !source.loading && !source.error && (
          <button type="button" onClick={locate} className="shrink-0 text-cafe-accent underline">
            查看原消息 ↗
          </button>
        )}
      </div>
      {detail && (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-cafe-subtle pt-4 text-compact text-cafe-muted">
          <dt>下一次同类任务</dt>
          <dd>还没接入</dd>
          <dt>写进的规则</dt>
          <dd>{row.rules.length ? `有 ${row.rules.length} 条关联记录 · 详情尚未接入` : '没有关联记录'}</dd>
        </dl>
      )}
    </article>
  );
}
