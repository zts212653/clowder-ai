import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { checked, ModificationHttpError } from './modification-http';
import { DISCOVERY_WINDOW_MS, FOCUS_REFRESH_MS, POLL_MS, PROJECTION_EVENT } from './useMediaMessageRequests';

/** The viewer is not allowed to see this (or it is gone for good); say nothing rather than "error". */
const HIDDEN = [401, 403, 410];

/** The request a cat took over from a message: what the line needs to start reading it by itself. */
export interface TextRequestFound {
  requestId: string;
  targetCatId: string;
}

type ReadState = 'idle' | 'looking' | 'found' | 'failed' | 'hidden';

type Outcome = { kind: 'found'; found: TextRequestFound } | { kind: 'looking' | 'failed' | 'hidden' };

/** An answer counts only when its own record says it came from this Human message. */
function outcomeOfAnswer(view: ContentModificationDetailView, messageId: string): Outcome {
  const { progress, requestId, payload } = view.record;
  return progress?.sourceKind === 'human_message' && progress.sourceMessageId === messageId
    ? { kind: 'found', found: { requestId, targetCatId: payload.targetCatId } }
    : { kind: 'looking' };
}

/** A 404 is the normal "not taken over yet"; being refused is "nothing to say"; anything else is "cannot tell". */
function outcomeOfError(error: unknown): Outcome {
  if (!(error instanceof ModificationHttpError)) return { kind: 'failed' };
  if (error.status === 404) return { kind: 'looking' };
  return { kind: HIDDEN.includes(error.status) ? 'hidden' : 'failed' };
}

/**
 * Whether the owner holds a request taken over from this exact Human message, asked by the message itself
 * (`GET /api/content-modifications/by-message/:messageId`): a read of the owner's own record that writes nothing, so a
 * historical message can be asked about freely. A 404 is the normal "no cat has taken it over yet" (the owner answers
 * a missing request and another person's alike), not a failure. Looking stops as soon as the request is found (the
 * owner holds one per Human message); after that the line reads and cancels the request by its own id. A fresh message
 * keeps asking for a bounded window as a fallback for a missed event; an old one is asked about once, and again only on
 * the owner's projection event, a focus (throttled) or a reload. The answer's own record must say it came from this
 * message, so a request that was merely generated for it is not taken for it.
 */
export function useTextMessageRequest(input: {
  messageId: string;
  /** When the message was sent; bounds how long a fresh message keeps looking for a cat to take it over. */
  sentAt: number;
}) {
  const { messageId, sentAt } = input;
  const [found, setFound] = useState<TextRequestFound | null>(null);
  const [readState, setReadState] = useState<ReadState>('idle');
  const generation = useRef(0);
  const lastReadAt = useRef(0);
  const foundRef = useRef(false);

  const refresh = useCallback(
    async (afterCurrentGet = true): Promise<void> => {
      const ticket = generation.current;
      lastReadAt.current = Date.now();
      let outcome: Outcome;
      try {
        const view = await checked<ContentModificationDetailView>(
          await apiFetch(`/api/content-modifications/by-message/${encodeURIComponent(messageId)}`, undefined, {
            afterCurrentGet,
          }),
        );
        outcome = outcomeOfAnswer(view, messageId);
      } catch (error) {
        outcome = outcomeOfError(error);
      }
      if (ticket !== generation.current) return;
      if (outcome.kind === 'found') {
        foundRef.current = true;
        setFound(outcome.found);
        setReadState('found');
      } else if (!foundRef.current) setReadState(outcome.kind);
    },
    [messageId],
  );

  useEffect(() => {
    generation.current += 1;
    lastReadAt.current = 0;
    foundRef.current = false;
    setFound(null);
    setReadState('idle');
    // Mounting is not a mutation: StrictMode's repeated setup shares the active physical GET.
    // Real projection changes and retries retain the trailing-generation fence through refresh's default.
    void refresh(false);
    // An explicit projection change is a real signal; focus and visibility are only hints and are throttled.
    const onProjectionChange = () => void refresh();
    const onHint = () => {
      if (Date.now() - lastReadAt.current >= FOCUS_REFRESH_MS) void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') onHint();
    };
    window.addEventListener(PROJECTION_EVENT, onProjectionChange);
    window.addEventListener('focus', onHint);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(PROJECTION_EVENT, onProjectionChange);
      window.removeEventListener('focus', onHint);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const settled = readState === 'found' || readState === 'hidden';
  useEffect(() => {
    if (settled) return;
    const deadline = sentAt + DISCOVERY_WINDOW_MS;
    if (Date.now() >= deadline) return;
    const timer = setInterval(() => {
      if (Date.now() >= deadline) clearInterval(timer);
      else if (document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [settled, sentAt, refresh]);

  return { found, failed: readState === 'failed', reload: refresh };
}
