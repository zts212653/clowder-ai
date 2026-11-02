'use client';
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import styles from './chat-reference.module.css';
import { chatReferenceBatch } from './chat-reference-batch';
import { ChatReferenceDemand, useChatReferenceDemand } from './useChatReferenceDemand';

export const ChatReferenceCardScope = createContext(true);
const EMPTY: readonly string[] = [];

/** Candidate discovery cannot change paragraph layout until every candidate has a verified result. */
export function ChatReferenceGroup({
  threadId,
  candidates = EMPTY,
  grid,
  sourceLine,
  children,
}: {
  threadId?: string;
  candidates?: readonly string[];
  grid: boolean;
  sourceLine?: number;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLParagraphElement>(null);
  const parentDemand = useContext(ChatReferenceDemand);
  const visible = useChatReferenceDemand(anchor, !!threadId) && parentDemand;
  const candidateKey = JSON.stringify([...new Set(candidates)]);
  const references: readonly string[] = useMemo(() => JSON.parse(candidateKey), [candidateKey]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const close =
        threadId && visible
          ? references.map((reference) => chatReferenceBatch.subscribe(threadId, reference, listener))
          : [];
      return () => {
        for (const dispose of close) dispose();
      };
    },
    [threadId, references, visible],
  );
  const snapshot = useCallback(
    () =>
      !!threadId &&
      references.length > 0 &&
      references.every((reference) => !!chatReferenceBatch.read(threadId, reference)),
    [threadId, references],
  );
  const verified = useSyncExternalStore(subscribe, snapshot, () => false);
  return (
    <ChatReferenceDemand.Provider value={visible}>
      <ChatReferenceCardScope.Provider value={verified}>
        <p
          ref={anchor}
          data-source-line={sourceLine}
          data-chat-reference-group={verified ? (grid ? 'grid' : 'single') : undefined}
          className={verified ? `${styles.group} ${grid ? styles.grid : ''}` : 'mb-2 last:mb-0 leading-relaxed'}
        >
          {verified
            ? Children.toArray(children).filter(
                (child) =>
                  !(isValidElement(child) && child.type === 'br') && (typeof child !== 'string' || !!child.trim()),
              )
            : children}
        </p>
      </ChatReferenceCardScope.Provider>
    </ChatReferenceDemand.Provider>
  );
}
