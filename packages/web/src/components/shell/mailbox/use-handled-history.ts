import { useEffect, useState, useSyncExternalStore } from 'react';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '../unified-attention-events';
import { createHandledHistoryRead, type HandledHistoryRead } from './handled-history-read';

export function useHandledHistory(owner: string | null, active: boolean, provided?: HandledHistoryRead) {
  const [local] = useState(createHandledHistoryRead);
  const read = provided ?? local;
  const snapshot = useSyncExternalStore(read.subscribe, read.getSnapshot, read.getSnapshot);
  useEffect(() => {
    read.setOwner(owner);
    read.setActive(active);
    return () => read.setActive(false);
  }, [read, owner, active]);
  useEffect(() => {
    const invalidate = () => read.invalidate();
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, invalidate);
      if (!provided) local.dispose();
    };
  }, [read, local, provided]);
  return { read, snapshot: snapshot.owner === owner ? snapshot : null };
}
