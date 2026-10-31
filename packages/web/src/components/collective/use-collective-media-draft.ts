import { useRef, useState } from 'react';
import { emptyMediaDraft, type MediaDraft, readMediaDraft, settleMediaDraft } from './collective-media-draft';

/** Own words are memory-first; commands must be durable before the first network effect. */
export function useCollectiveMediaDraft(key: string) {
  const [draft, publish] = useState(() => {
    try {
      return readMediaDraft(key);
    } catch {
      return emptyMediaDraft();
    }
  });
  const current = useRef(draft),
    synced = useRef(JSON.stringify(draft));
  const [error, setError] = useState(false);
  const save = (next: MediaDraft) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setError(true);
      return false;
    }
    synced.current = JSON.stringify(next);
    current.current = next;
    publish(next);
    setError(false);
    return true;
  };
  const update = (patch: Partial<Pick<MediaDraft, 'body' | 'anchor'>>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    publish(next);
    save(next);
  };
  const settle = (pending: NonNullable<MediaDraft['pending']>, result: 'committed' | 'conflict') => {
    const dirty = JSON.stringify(current.current) !== synced.current;
    const stored = settleMediaDraft(key, pending, result);
    const next = dirty ? { ...stored, body: current.current.body, anchor: current.current.anchor } : stored;
    synced.current = JSON.stringify(stored);
    current.current = next;
    publish(next);
    return next;
  };
  return { draft, current, save, update, settle, error };
}
