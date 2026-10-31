import type { HydratedMessageBundle } from '@cat-cafe/shared';
import { MessageBundleItemView } from '../MessageBundleItemView';
import { messageBundleSenderLabel } from '../message-bundle-sender';
import { useShellCopy } from '../shell/shell-copy';
import { MessageBundlePreviewItem } from './MessageBundlePreviewItem';
import { messageReadingCopy } from './message-reading-copy';

interface Props {
  messageId: string;
  data: HydratedMessageBundle | null;
  error: boolean;
  expanded: boolean;
  forwarderName: string;
  getCatLabel: (catId: string) => string;
  onJump: (threadId: string, messageId?: string) => void;
  onToggle: () => void;
  onRetry: () => void;
}

/** Note and paper are two visual blocks of one durable Bundle message. */
export function MessageBundlePaperCard({
  messageId,
  data,
  error,
  expanded,
  forwarderName,
  getCatLabel,
  onJump,
  onToggle,
  onRetry,
}: Props) {
  const t = useShellCopy(messageReadingCopy);
  if (error)
    return (
      <div role="alert" className="rounded-xl border border-cafe p-3 text-sm text-cafe-muted">
        {t.readError}
        <button type="button" className="ml-2 min-h-11 text-cafe-interactive" onClick={onRetry}>
          {t.retry}
        </button>
      </div>
    );
  if (!data) return <output className="block py-3 text-sm text-cafe-muted">{t.reading}</output>;
  const authorName = (item: (typeof data.items)[number]) =>
    item.status === 'available'
      ? messageBundleSenderLabel(item.from, data.createdBy, forwarderName, getCatLabel)
      : undefined;
  const participants = [...new Set(data.items.map(authorName).filter((name): name is string => name !== undefined))];
  const single = data.items.length === 1;
  const messageCount = new Set(data.items.map((item) => item.messageId)).size;
  return (
    <div data-message-bundle-id={messageId} className="flex w-full min-w-0 flex-col gap-2">
      {data.note && (
        <div
          data-message-bundle-note
          role="note"
          aria-label={t.note}
          className="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-xl px-3.5 py-2 text-sm"
          style={{ background: 'var(--color-cocreator-surface)', color: 'var(--color-cocreator-text)' }}
        >
          {data.note}
        </div>
      )}
      <section data-message-bundle-card className="min-w-0 rounded-xl border border-cafe bg-cafe-surface p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-cafe-muted">
          <button
            type="button"
            className="min-w-0 max-w-full truncate text-left font-semibold text-cafe-interactive disabled:text-cafe-muted"
            disabled={!data.sourceThread}
            onClick={() => data.sourceThread && onJump(data.sourceThread.id)}
          >
            {t.from(data.sourceThread?.title ?? t.sourceUnavailable)}
          </button>
          <span className="ml-auto shrink-0">{t.count(messageCount)}</span>
        </div>
        <p className="mt-1 break-words text-xs text-cafe-muted">
          {t.forwardedBy(forwarderName)}
          {participants.length > 0 ? ` · ${participants.join(' · ')}` : ''}
        </p>
        {single || expanded ? (
          <div className="mt-3 space-y-3">
            {data.items.map((item, index) => (
              <div key={`${index}:${item.messageId}`} className="border-t border-cafe pt-3 first:border-0 first:pt-0">
                <MessageBundleItemView
                  item={item}
                  index={index}
                  createdBy={data.createdBy}
                  forwarderName={forwarderName}
                  getCatLabel={getCatLabel}
                  onJump={onJump}
                  labels={t}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 divide-y divide-cafe">
            {data.items.slice(0, 2).map((item, index) => (
              <MessageBundlePreviewItem key={`${index}:${item.messageId}`} item={item} authorName={authorName(item)} />
            ))}
          </div>
        )}
        {!single && (
          <button
            type="button"
            className="mt-2 min-h-11 text-compact font-semibold text-cafe-interactive"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded
              ? t.collapse
              : messageCount < data.items.length
                ? t.showAllParts(data.items.length)
                : t.showAll(messageCount)}
          </button>
        )}
      </section>
    </div>
  );
}
