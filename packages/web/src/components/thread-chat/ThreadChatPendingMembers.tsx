'use client';

import type { CapabilityTipContext } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import type { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import type { ChatMessage } from '@/stores/chat-types';
import {
  getSilentActiveTurnDeadline,
  getStreamingTipContexts,
  isStreamingTipSuppressed,
} from '../capability-tip-placement';
import { PendingMemberBubble } from '../PendingMemberBubble';
import { derivePendingMemberInvocations } from '../pending-member-projection';

type ThreadLiveness = ReturnType<typeof useThreadLiveness>;

export function ThreadChatPendingMembers({
  threadId,
  messages,
  liveness,
}: {
  threadId: string;
  messages: readonly ChatMessage[];
  liveness: ThreadLiveness;
}) {
  const { hasActive, activeInvocations, catStatuses, catInvocations, intentMode } = liveness;
  const pendingInvocations = useMemo(
    () => (hasActive ? derivePendingMemberInvocations(activeInvocations, messages, threadId) : []),
    [activeInvocations, hasActive, messages, threadId],
  );
  const tipContexts = useMemo<readonly CapabilityTipContext[]>(() => getStreamingTipContexts(intentMode), [intentMode]);
  const [, bumpLiveness] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const deadlines = new Set<number>();
    for (const invocation of pendingInvocations) {
      const deadline = getSilentActiveTurnDeadline(catInvocations[invocation.catId]?.appServerLifecycle);
      if (deadline !== null && deadline > now) deadlines.add(deadline);
    }
    if (deadlines.size === 0) return;
    const timers = [...deadlines].map((deadline) =>
      window.setTimeout(() => bumpLiveness((epoch) => epoch + 1), Math.max(1, deadline - now + 1)),
    );
    return () => {
      timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
    };
  }, [catInvocations, pendingInvocations]);

  const tipInvocationId =
    pendingInvocations.find(
      (invocation) =>
        !isStreamingTipSuppressed(catStatuses[invocation.catId], catInvocations[invocation.catId]?.appServerLifecycle),
    )?.invocationId ?? null;

  return pendingInvocations.map((invocation) => (
    <PendingMemberBubble
      key={`pending-${invocation.invocationId}`}
      catId={invocation.catId}
      invocationId={invocation.invocationId}
      catStatus={catStatuses[invocation.catId]}
      appServerLifecycle={catInvocations[invocation.catId]?.appServerLifecycle}
      tipContexts={tipContexts}
      showCapabilityTip={invocation.invocationId === tipInvocationId}
    />
  ));
}
