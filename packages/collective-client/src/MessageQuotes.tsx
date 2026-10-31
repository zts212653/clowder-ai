import { type CollectiveMessageQuote, collectiveMessageQuoteSchema } from '@cat-cafe/shared';
import { QuoteExcerpt, SelectionQuoteButton, useTextSelectionAction } from '@cat-cafe/ui';
import { type Dispatch, type ReactNode, type SetStateAction, useRef } from 'react';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import type { ComposerDraft } from './composer-draft.js';
import { useMessageQuotes } from './message-quote-context.js';

export function ComposerMessageQuotes({
  draft,
  setDraft,
}: {
  draft: ComposerDraft;
  setDraft: Dispatch<SetStateAction<ComposerDraft>>;
}) {
  return (
    <MessageQuotes
      quotes={draft.contextAttachments}
      onRemove={(id) =>
        setDraft((current) => ({
          ...current,
          contextAttachments: current.contextAttachments?.filter((quote) => quote.id !== id),
        }))
      }
    />
  );
}

function MessageQuoteCard({
  quote,
  onRemove,
  onOpenSource,
  language,
}: {
  readonly quote: CollectiveMessageQuote;
  readonly onRemove?: (id: string) => void;
  readonly onOpenSource?: (source: CollectiveMessageQuote['source']) => void;
  readonly language: string;
}) {
  const label =
    quote.source.kind === 'collective_message'
      ? `#${quote.source.channelId}`
      : language === 'en'
        ? 'Source message'
        : '原消息';
  return (
    <div className="message-quote">
      <header>
        {onOpenSource ? (
          <button type="button" onClick={() => onOpenSource(quote.source)}>
            {label}
            <span> ↗</span>
          </button>
        ) : (
          <span>{language === 'en' ? 'Quote' : '引用'}</span>
        )}
        {onRemove && (
          <button
            type="button"
            aria-label={language === 'en' ? 'Remove quote' : '移除引用'}
            onClick={() => onRemove(quote.id)}
          >
            ×
          </button>
        )}
      </header>
      <QuoteExcerpt
        text={quote.text}
        comment={quote.comment}
        commentLabel={language === 'en' ? 'Comment' : '批注'}
        compact={!!onRemove}
      />
    </div>
  );
}

export function MessageQuotes({
  quotes,
  onRemove,
}: {
  readonly quotes?: readonly CollectiveMessageQuote[];
  readonly onRemove?: (id: string) => void;
}) {
  const actions = useMessageQuotes();
  const language = useCollectiveLanguage();
  return quotes?.length ? (
    <div className="message-quotes">
      {quotes.map((quote) => (
        <MessageQuoteCard
          key={quote.id}
          quote={quote}
          onRemove={onRemove}
          onOpenSource={actions?.openSource}
          language={language}
        />
      ))}
    </div>
  ) : null;
}

export function QuotableMessage({
  event,
  children,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const actions = useMessageQuotes();
  const language = useCollectiveLanguage();
  const selection = useTextSelectionAction(root, Boolean(actions && event.location), event.eventId, 'viewport');
  const add = () => {
    if (!selection || !event.location) return;
    const quote = collectiveMessageQuoteSchema.safeParse({
      v: 1,
      kind: 'quote',
      id: `ctx_${crypto.randomUUID()}`,
      text: selection.text,
      selectionStart: selection.selectionStart,
      selectionEnd: selection.selectionEnd,
      source: {
        kind: 'collective_message',
        serviceInstanceId: event.serviceInstanceId,
        collectiveId: event.collectiveId,
        channelId: event.location.channelId,
        eventId: event.eventId,
      },
    });
    if (!quote.success) return;
    actions?.add(quote.data);
    window.getSelection()?.removeAllRanges();
  };
  return (
    <div ref={root} data-context-quote-source="collective_message">
      {children}
      {selection && selection.text.length <= 20_000 && (
        <SelectionQuoteButton
          position={selection.position}
          label={language === 'en' ? 'Quote in chat' : '引用到聊天'}
          onQuote={add}
        />
      )}
    </div>
  );
}
