'use client';

export const THEATER_REPLAY_EVENT = 'cat-cafe:open-theater-replay';

export function openTheaterReplay(threadId: string): void {
  if (typeof window === 'undefined' || !threadId) return;
  window.dispatchEvent(new CustomEvent<string>(THEATER_REPLAY_EVENT, { detail: threadId }));
}

export function subscribeTheaterReplay(listener: (threadId: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const threadId = (event as CustomEvent<unknown>).detail;
    if (typeof threadId === 'string' && threadId) listener(threadId);
  };
  window.addEventListener(THEATER_REPLAY_EVENT, handler);
  return () => window.removeEventListener(THEATER_REPLAY_EVENT, handler);
}
