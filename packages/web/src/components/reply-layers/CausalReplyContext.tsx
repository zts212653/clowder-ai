'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { causalBoundaryKey, projectCausalReplies } from './causal-reply-projection';

const CausalReplyContext = createContext<ReturnType<typeof projectCausalReplies> | null>(null);

/** One proof gate controls both the original body and every continuation. */
export function CausalReplyProvider({ messages, children }: { messages: readonly ChatMessage[]; children: ReactNode }) {
  const [verified, setVerified] = useState<ReadonlyMap<string, string>>(new Map());
  const candidates = messages.flatMap((message) =>
    message.lifecycle?.kind === 'response'
      ? (message.lifecycle.appendBoundaries ?? []).map((boundary) => ({
          key: causalBoundaryKey(message, boundary),
          prefix: message.content.trimStart().slice(0, boundary.contentOffset),
          hash: boundary.prefixSha256,
        }))
      : [],
  );
  // Streaming appends do not change these prefixes and must not reset a verified cut.
  const proofKey = JSON.stringify(candidates);
  // biome-ignore lint/correctness/useExhaustiveDependencies: proofKey exactly encodes candidates; appending body text must retain the verified prefix.
  useEffect(() => {
    if (!globalThis.crypto?.subtle) return;
    let active = true;
    void Promise.all(
      candidates.map(async ({ key, prefix, hash }) => {
        const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix));
        const actual = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
        return actual === hash ? ([key, prefix] as const) : undefined;
      }),
    )
      .then((proofs) => {
        if (active) setVerified(new Map(proofs.filter((proof) => proof !== undefined)));
      })
      .catch(() => {
        // An unverifiable boundary keeps the canonical body visible in full.
      });
    return () => {
      active = false;
    };
  }, [proofKey]);
  const projection = useMemo(() => projectCausalReplies(messages, verified), [messages, verified]);
  return <CausalReplyContext.Provider value={projection}>{children}</CausalReplyContext.Provider>;
}

export function useCausalReplies() {
  return useContext(CausalReplyContext);
}

export function causalContinuationId(inputMessageId: string, responseId: string) {
  return `reply-continuation-${encodeURIComponent(inputMessageId)}-${encodeURIComponent(responseId)}`;
}

export function focusCausalContinuation(inputMessageId: string, responseId: string) {
  const id = causalContinuationId(inputMessageId, responseId);
  // The input's existing viewport owner mounts its continuation as one row.
  if (!document.getElementById(id)) focusLineageMessage(inputMessageId);
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.focus({ preventScroll: true });
  return true;
}
