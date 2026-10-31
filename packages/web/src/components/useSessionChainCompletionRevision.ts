'use client';

import { useEffect, useRef, useState } from 'react';

/** Invalidate the owner's chain read on observed slot completion, never on thread navigation. */
export function useSessionChainCompletionRevision(
  threadId: string,
  activeInvocations: Record<string, { catId: string }>,
  enabled: boolean,
): number {
  const [revision, setRevision] = useState(0);
  const previous = useRef<{ threadId: string; slots: Set<string> } | null>(null);
  const slotSignal = JSON.stringify(
    Object.entries(activeInvocations)
      .map(([id, slot]) => JSON.stringify([id, slot.catId]))
      .sort(),
  );
  useEffect(() => {
    const slots = new Set<string>(JSON.parse(slotSignal));
    const before = previous.current;
    previous.current = { threadId, slots };
    if (enabled && before?.threadId === threadId && [...before.slots].some((id) => !slots.has(id))) {
      setRevision((value) => value + 1);
    }
  }, [threadId, slotSignal, enabled]);
  return revision;
}
