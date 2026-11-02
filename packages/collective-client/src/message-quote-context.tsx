import type { CollectiveMessageQuote } from '@cat-cafe/shared';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

interface MessageQuoteActions {
  namespace?: string;
  request?: CollectiveMessageQuote;
  add(quote: CollectiveMessageQuote): void;
  consumed(id: string): void;
  openSource?: (source: CollectiveMessageQuote['source']) => void;
}
const Context = createContext<MessageQuoteActions | undefined>(undefined);
export const useMessageQuotes = () => useContext(Context);

/** A Channel and its open Topic each own a composer target. A quote never enters both drafts. */
export function MessageQuoteProvider({
  children,
  onOpenSource,
  namespace,
}: {
  readonly children: ReactNode;
  readonly onOpenSource?: MessageQuoteActions['openSource'];
  readonly namespace?: string;
}) {
  const parent = useMessageQuotes();
  const openSource = onOpenSource ?? parent?.openSource;
  const storageNamespace = namespace ?? parent?.namespace;
  const [requests, setRequests] = useState(() => new Map<string | undefined, CollectiveMessageQuote>());
  const request = requests.get(storageNamespace);
  const add = useCallback(
    (quote: CollectiveMessageQuote) =>
      setRequests((current) => {
        const next = new Map(current);
        next.set(storageNamespace, quote);
        return next;
      }),
    [storageNamespace],
  );
  const consumed = useCallback(
    (id: string) =>
      setRequests((current) => {
        if (current.get(storageNamespace)?.id !== id) return current;
        const next = new Map(current);
        next.delete(storageNamespace);
        return next;
      }),
    [storageNamespace],
  );
  const value = useMemo(
    () => ({ namespace: storageNamespace, request, add, consumed, openSource }),
    [storageNamespace, request, add, consumed, openSource],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
