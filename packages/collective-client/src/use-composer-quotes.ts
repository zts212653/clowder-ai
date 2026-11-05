import { type Dispatch, type RefObject, type SetStateAction, useEffect } from 'react';
import type { ComposerDraft } from './composer-draft.js';
import { useMessageQuotes } from './message-quote-context.js';

export function useComposerQuotes(
  quoteCount: number | undefined,
  setDraft: Dispatch<SetStateAction<ComposerDraft>>,
  input: RefObject<HTMLTextAreaElement>,
  notify: Dispatch<SetStateAction<string | undefined>>,
  language: string,
) {
  const quotes = useMessageQuotes();
  useEffect(() => {
    const quote = quotes?.request;
    if (!quote) return;
    if ((quoteCount ?? 0) >= 12) {
      notify(language === 'en' ? 'A message can contain up to 12 quotes.' : '每条消息最多引用 12 处，请先移除一处。');
    } else {
      setDraft((current) =>
        current.contextAttachments?.some((item) => item.id === quote.id)
          ? current
          : { ...current, contextAttachments: [...(current.contextAttachments ?? []), quote] },
      );
      input.current?.focus();
    }
    quotes.consumed(quote.id);
  }, [quotes, quoteCount, language, setDraft, input, notify]);
}
