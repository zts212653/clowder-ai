'use client';
import { useRouter } from 'next/navigation';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { MemoryReadState } from './MemoryReadState';
import { MemoryTasteActions } from './MemoryTasteActions';
import { TasteMetadata } from './MemoryTasteCard';
import { MemoryTasteCorrections } from './MemoryTasteCorrections';
import { TasteApprovalSummary, TasteSourceLocation } from './MemoryTasteProvenance';
import { MemoryTasteRecall } from './MemoryTasteRecall';
import { tasteQuote } from './taste-format';
import { canOpenTasteSource, isTasteMemory, isTasteSource, type TasteMemory, type TasteSource } from './taste-types';
import { useMemoryRead } from './use-memory-read';

export function MemoryTasteDetail({
  entry,
  close,
  reload,
  closeLabel = '返回全部',
}: {
  entry: TasteMemory;
  close: () => void;
  reload: () => void;
  closeLabel?: string;
}) {
  const endpoint = `/api/memory/taste/${encodeURIComponent(entry.id)}?revision=${encodeURIComponent(entry.revision)}`;
  const detail = useMemoryRead<TasteMemory>(endpoint, isTasteMemory);
  const source = useMemoryRead<TasteSource>(endpoint.replace('?revision=', '/source?revision='), isTasteSource);
  const router = useRouter();
  const data = detail.data;
  const locate = () => {
    if (!canOpenTasteSource(source.data) || source.loading || source.error) return;
    handleTeleportEvent({ threadId: source.data.threadId, messageId: source.data.messageId }, null, {
      pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
      scrollToMessage,
    });
  };
  return (
    <aside
      aria-label="品味详情"
      className="min-w-0 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">品味详情</h2>
        <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
          {closeLabel}
        </button>
      </div>
      <MemoryReadState
        loading={detail.loading}
        error={detail.error}
        empty={false}
        noun="这条品味"
        retry={detail.retry}
      />
      {detail.error && (
        <p className="mt-2 text-compact text-cafe-muted">
          版本可能已变化。
          <button type="button" onClick={reload} className="ml-1 text-cafe-accent underline">
            重读品味列表
          </button>
        </p>
      )}
      {data && !detail.loading && !detail.error && (
        <>
          <div className="mt-4">
            <TasteMetadata entry={data} />
          </div>
          <p className="mt-3 text-xs text-cafe-muted">{data.takeaway ? '已有的做法假设' : '原话 · 还没有做法假设'}</p>
          <h3 className="mt-2 whitespace-pre-wrap break-words font-serif text-display-sm">
            {data.takeaway || (data.quotes.length ? data.quotes.map(tasteQuote).join('\n\n') : data.title)}
          </h3>
          <MemoryTasteActions key={`${data.id}:${data.revision}`} entry={data} reload={reload} />
          <MemoryTasteCorrections proposals={data.correctionProposals ?? []} revision={data.revision} reread={reload} />
          {data.takeaway && (
            <section className="mt-5 border-t border-cafe-subtle pt-4">
              <h4 className="text-compact text-cafe-muted">原话</h4>
              {data.quotes.length ? (
                data.quotes.map((quote, i) => (
                  <blockquote
                    key={`${i}-${quote.slice(0, 24)}`}
                    className="mt-2 whitespace-pre-wrap break-words border-l-2 border-cafe-subtle pl-3 text-sm"
                  >
                    {tasteQuote(quote)}
                  </blockquote>
                ))
              ) : (
                <p className="mt-2 text-sm">原话没有记录下来</p>
              )}
            </section>
          )}
          <section className="mt-5 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">当时</h4>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{data.scene}</p>
          </section>
          <section className="mt-5 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">什么时候会想起</h4>
            <p className="mt-2 text-sm">{data.whenRemembered || '触发条件暂时读不到'}</p>
          </section>
          <TasteApprovalSummary entry={data} />
          <section className="mt-5 border-t border-cafe-subtle pt-4">
            <h4 className="mb-3 text-compact text-cafe-muted">被想起</h4>
            <MemoryTasteRecall entry={entry} />
          </section>
          <TasteSourceLocation source={source} locate={locate} />
        </>
      )}
    </aside>
  );
}
