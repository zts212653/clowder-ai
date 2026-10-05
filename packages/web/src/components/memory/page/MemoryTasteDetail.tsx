'use client';
import { useRouter } from 'next/navigation';
import { ExternalLinkIcon } from '@/components/HubConfigIcons';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { MemoryReadState } from './MemoryReadState';
import { TasteMetadata } from './MemoryTasteCard';
import { MemoryTasteRecall } from './MemoryTasteRecall';
import { tasteQuote, tasteTime } from './taste-format';
import { canOpenTasteSource, isTasteMemory, isTasteSource, type TasteMemory, type TasteSource } from './taste-types';
import { useMemoryRead } from './use-memory-read';

export function MemoryTasteDetail({
  entry,
  close,
  reload,
}: {
  entry: TasteMemory;
  close: () => void;
  reload: () => void;
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
          返回全部
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
          <p className="mt-2 text-compact text-cafe-muted">原品味照常生效，概括候选尚未接入。</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {['确认这句', '修改', '忘掉'].map((label) => (
              <button
                type="button"
                disabled
                key={label}
                className="rounded-lg border border-cafe-subtle px-3 py-2 text-compact opacity-50"
              >
                {label}
              </button>
            ))}
            <span className="text-xs text-cafe-muted">尚未接入</span>
          </div>
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
          <section className="mt-5 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">对应审批</h4>
            <p className="mt-2 text-sm">
              {data.approval?.status === 'approved'
                ? `已批准${data.approval.approvedAt ? ` · ${tasteTime(data.approval.approvedAt)}` : ' · 批准时间没有记录下来'}`
                : data.approval?.status === 'not_recorded'
                  ? '审批记录没有记录下来'
                  : '暂时读不到审批记录'}
            </p>
            {data.approval?.proposedAt && (
              <p className="mt-1 text-xs text-cafe-muted">提出于 {tasteTime(data.approval.proposedAt)}</p>
            )}
          </section>
          <section className="mt-5 border-t border-cafe-subtle pt-4">
            <h4 className="mb-3 text-compact text-cafe-muted">被想起</h4>
            <MemoryTasteRecall entry={entry} />
          </section>
          <section className="mt-5 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">出处</h4>
            <p className="mt-2 break-words text-sm">
              {source.loading
                ? '正在读取出处…'
                : source.error
                  ? '暂时读不到出处'
                  : source.data?.status === 'not_recorded'
                    ? '原始对话没有记录下来'
                    : source.data?.status === 'ready'
                      ? source.data.title || '对话 · 标题没有记录下来'
                      : '暂时读不到出处对话'}
            </p>
            {source.error && (
              <button type="button" onClick={source.retry} className="mt-2 text-compact text-cafe-accent underline">
                重读出处
              </button>
            )}
            {canOpenTasteSource(source.data) && !source.loading && !source.error && (
              <button
                type="button"
                onClick={locate}
                className="mt-2 inline-flex items-center gap-1 text-compact text-cafe-accent underline"
              >
                查看原消息
                <span aria-hidden="true">
                  <ExternalLinkIcon />
                </span>
              </button>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
