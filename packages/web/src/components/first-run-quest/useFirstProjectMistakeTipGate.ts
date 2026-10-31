'use client';

import { useEffect, useRef, useState } from 'react';

interface FirstProjectMistakeTipGateParams {
  threadId: string;
  phase?: string;
  messageCount: number;
  hasActiveInvocation: boolean;
}

/**
 * Arm the phase-4 "mistake tip" after an invocation produces new output.
 *
 * Uses the same sawNewPhaseOutput pattern as useFirstProjectPreviewAutoOpen.
 * The gate resets each time an invocation starts, so the Phase 2→4 transition
 * (which also has hasActiveInvocation + new messages) only produces a brief
 * window — the user's next message resets the gate and re-arms it for the
 * actual Phase 4 delivery.
 */
export function useFirstProjectMistakeTipGate({
  threadId,
  phase,
  messageCount,
  hasActiveInvocation,
}: FirstProjectMistakeTipGateParams) {
  const [ready, setReady] = useState(false);
  const baselineRef = useRef<number | null>(null);
  const sawNewOutputRef = useRef(false);
  const prevActiveRef = useRef(false);
  const prevPhaseRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'phase-7-dev') {
      baselineRef.current = null;
      sawNewOutputRef.current = false;
      prevActiveRef.current = false;
      prevPhaseRef.current = phase;
      setReady(false);
      return;
    }

    const enteredPhase4 = prevPhaseRef.current !== 'phase-7-dev';
    if (enteredPhase4 || baselineRef.current === null) {
      baselineRef.current = messageCount;
      sawNewOutputRef.current = false;
      setReady(false);
    }

    // Reset when a NEW invocation starts (rising edge of hasActiveInvocation)
    if (hasActiveInvocation && !prevActiveRef.current) {
      baselineRef.current = messageCount;
      sawNewOutputRef.current = false;
      setReady(false);
    }

    // Arm whenever Phase 4 gains new output after the current baseline.
    // Most of the time this happens during an active invocation, but after
    // leaving and re-entering Phase 4 we can also receive the next message
    // after the invocation has already settled.
    if (messageCount > (baselineRef.current ?? 0)) {
      sawNewOutputRef.current = true;
    }
    setReady(!hasActiveInvocation && sawNewOutputRef.current);
    prevActiveRef.current = hasActiveInvocation;
    prevPhaseRef.current = phase;
  }, [phase, messageCount, hasActiveInvocation, threadId]);

  return ready;
}
