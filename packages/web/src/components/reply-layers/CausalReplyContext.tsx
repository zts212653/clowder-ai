'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useProcessTalkPreference } from '@/hooks/useProcessTalkPreference';
import type { ChatMessage } from '@/stores/chat-types';
import { readChatScrollState } from '@/utils/chat-scroll-memory';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { causalBoundaryKey, projectCausalReplies } from './causal-reply-projection';
import { projectReplyOutput, type ReplyOutputProjection } from './reply-output';

export interface CausalReadingReference {
  anchorMessageId: string;
  targetMessageId: string;
  targetCatId?: string;
  kind: 'reply' | 'input';
}

const CausalReplyContext = createContext<
  | (ReturnType<typeof projectCausalReplies> & {
      nativeOutputs: ReadonlyMap<string, ReplyOutputProjection>;
      loadedMessageIds: ReadonlySet<string>;
      readingReference: CausalReadingReference | null;
      openReference: (reference: CausalReadingReference | null) => void;
      socketConnected?: boolean | null;
      catStatuses: Readonly<Record<string, string>>;
      revealReference?: (element: HTMLElement) => void;
    })
  | null
>(null);

/** One proof gate controls both the original body and every continuation. */
export function CausalReplyProvider({
  messages,
  threadId,
  children,
  socketConnected,
  catStatuses = {},
  revealReference,
}: {
  messages: readonly ChatMessage[];
  threadId: string;
  children: ReactNode;
  socketConnected?: boolean | null;
  catStatuses?: Readonly<Record<string, string>>;
  revealReference?: (element: HTMLElement) => void;
}) {
  const [readingReference, openReference] = useState<CausalReadingReference | null>(null);
  const [verified, setVerified] = useState<ReadonlyMap<string, string>>(new Map());
  const renderedBoundaryCounts = useRef(new Map<string, number>());
  const bodies = useMemo(
    () =>
      messages.flatMap((message) => {
        const layout = message.extra?.outputLayout;
        return message.lifecycle?.kind === 'response' &&
          message.lifecycle.appendBoundaries?.length &&
          layout?.status === 'available'
          ? [{ message, layout, key: `body:${message.id}:${layout.contentRevision.sha256}` }]
          : [];
      }),
    [messages],
  );
  const preference = useProcessTalkPreference(bodies.length > 0);
  const candidates = [
    ...messages.flatMap((message) =>
      message.lifecycle?.kind === 'response'
        ? (message.lifecycle.appendBoundaries ?? []).map((boundary) => ({
            key: causalBoundaryKey(message, boundary),
            prefix: message.content.trimStart().slice(0, boundary.contentOffset),
            hash: boundary.prefixSha256,
          }))
        : [],
    ),
    ...bodies.map(({ message, layout, key }) => ({
      key,
      prefix: message.content,
      hash: layout.contentRevision.sha256,
    })),
  ];
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
  const projection = useMemo(() => {
    const reading = readChatScrollState(threadId);
    const readingId = reading?.anchor === 'offset' ? reading.messageAnchor?.messageId : undefined;
    // New cuts may move text out of the paragraph the existing History owner is
    // restoring. Keep that response's committed ranges while they are being read;
    // whole-message reading remains available without relocating the text.
    const presentationMessages = messages.map((message) => {
      const lifecycle = message.lifecycle;
      if (lifecycle?.kind !== 'response') return message;
      const boundaries = lifecycle.appendBoundaries;
      if (
        !readingId ||
        !boundaries?.length ||
        (readingId !== message.id && !boundaries.some((cut) => cut.inputMessageId === readingId))
      )
        return message;
      const count = renderedBoundaryCounts.current.get(message.id) ?? 0;
      return count >= boundaries.length
        ? message
        : { ...message, lifecycle: { ...lifecycle, appendBoundaries: boundaries.slice(0, count) } };
    });
    const nativeOutputs = new Map<string, ReplyOutputProjection>();
    bodies.forEach(({ message, layout, key }) => {
      if (verified.get(key) !== message.content) return;
      const output = projectReplyOutput(message, threadId, layout.contentRevision.sha256, preference.mode);
      if (output) nativeOutputs.set(message.id, output);
    });
    return {
      ...projectCausalReplies(presentationMessages, verified),
      nativeOutputs,
      loadedMessageIds: new Set(messages.map((message) => message.id)),
      readingReference,
      openReference,
      socketConnected,
      catStatuses,
      revealReference,
    };
  }, [
    bodies,
    messages,
    verified,
    threadId,
    preference.mode,
    readingReference,
    socketConnected,
    catStatuses,
    revealReference,
  ]);
  useLayoutEffect(() => {
    const counts = new Map<string, number>();
    projection.continuations.forEach((slices) =>
      slices.forEach(({ response }) => counts.set(response.id, (counts.get(response.id) ?? 0) + 1)),
    );
    renderedBoundaryCounts.current = counts;
  }, [projection]);
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
  const nextInput = target.dataset.causalNextInput;
  if (nextInput) return focusCausalContinuation(nextInput, responseId);
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.focus({ preventScroll: true });
  return true;
}
