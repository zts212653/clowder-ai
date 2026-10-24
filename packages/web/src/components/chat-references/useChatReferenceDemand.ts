'use client';
import { createContext, type RefObject, useEffect, useState } from 'react';

export const ChatReferenceDemand = createContext(true);
const pools = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    listeners: Map<Element, (visible: boolean) => void>;
  }
>();

/** Read metadata near the viewport without changing the paragraph's DOM or cached presentation. */
export function useChatReferenceDemand(anchor: RefObject<HTMLElement | null>, enabled = true): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = anchor.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return;
    const root = element.closest('[data-chat-container]');
    let pool = pools.get(root);
    if (!pool) {
      const listeners = new Map<Element, (visible: boolean) => void>();
      pool = {
        listeners,
        observer: new IntersectionObserver(
          (entries) => {
            for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
          },
          { root, rootMargin: '256px' },
        ),
      };
      pools.set(root, pool);
    }
    const { observer, listeners } = pool;
    listeners.set(element, setVisible);
    observer.observe(element);
    return () => {
      observer.unobserve(element);
      listeners.delete(element);
      if (!listeners.size) {
        observer.disconnect();
        pools.delete(root);
      }
    };
  }, [anchor, enabled]);
  return !enabled || visible;
}
