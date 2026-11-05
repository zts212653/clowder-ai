import type { ContentModificationContextCatalogue, MediaContextAttachment } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { hasRequestFromMessage } from './media-message-request';
import { checked, json, ModificationHttpError } from './modification-http';

const CONTEXT = '/api/content-modifications/context';
export const POLL_MS = 4000;
/**
 * How long after sending a visible page keeps asking whether a cat has taken the message over, as a fallback for a
 * missed event. When a cat takes a message over the owner pushes `entrusted_work_projection_invalidated`, which the web
 * turns into the DOM event below, so the normal path is that event; the same takeover by another cat reuses that selected
 * work request and pushes the same event. The asking stops as soon as the request from this message is
 * found, and an old message that nobody took over is only re-read on that event, a focus or a reload.
 */
export const DISCOVERY_WINDOW_MS = 10 * 60 * 1000;
/** Focus and visibility changes are cheap hints, not reasons to re-read every old message at once. */
export const FOCUS_REFRESH_MS = 15_000;
export const PROJECTION_EVENT = 'cat-cafe:entrusted-work-projection-invalidated';
/** The viewer is not allowed to see (or can no longer find) the source; say nothing rather than "error". */
const UNREADABLE = [401, 403, 404, 410];

type ReadState = 'idle' | 'ok' | 'failed' | 'hidden';

/**
 * What the owner knows about the work a sent media message points at, for the join to that exact message. The read is
 * keyed by the attachment's source and the message id, so an optimistic message that later gets its real id asks again.
 * An answer that was started earlier never replaces one that was started later.
 */
export function useMediaMessageRequests(input: {
  messageId: string;
  /** When the message was sent; bounds how long a fresh message keeps looking for a cat to take it over. */
  sentAt: number;
  attachment: (Pick<MediaContextAttachment, 'source'> & Partial<Pick<MediaContextAttachment, 'id'>>) | null;
}) {
  const source = input.attachment?.source;
  const attachmentId = input.attachment?.id;
  const sourceKey = source ? `${input.messageId}:${attachmentId ?? ''}:${JSON.stringify(source)}` : null;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [catalogue, setCatalogue] = useState<ContentModificationContextCatalogue | null>(null);
  const [readState, setReadState] = useState<ReadState>('idle');
  const generation = useRef(0);
  const started = useRef(0);
  const applied = useRef(0);
  const lastReadAt = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const current = sourceRef.current;
    if (!current) return;
    const ticket = generation.current;
    const order = ++started.current;
    lastReadAt.current = Date.now();
    const stale = () => ticket !== generation.current || order < applied.current;
    try {
      const next = await checked<ContentModificationContextCatalogue>(
        await apiFetch(CONTEXT, json({ source: current })),
      );
      if (stale()) return;
      applied.current = order;
      setCatalogue(next);
      setReadState('ok');
    } catch (error) {
      if (stale()) return;
      applied.current = order;
      if (error instanceof ModificationHttpError && UNREADABLE.includes(error.status)) {
        setCatalogue(null);
        setReadState('hidden');
        return;
      }
      setReadState('failed');
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    started.current = 0;
    applied.current = 0;
    lastReadAt.current = 0;
    setCatalogue(null);
    setReadState('idle');
    if (!sourceKey) return;
    void refresh();
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
  }, [sourceKey, refresh]);

  // Each named work keeps looking until its own takeover is listed. Sibling progress cannot end this discovery.
  const unreadable = readState === 'hidden';
  const found = catalogue ? hasRequestFromMessage(catalogue, input.messageId, attachmentId) : false;
  const { sentAt } = input;
  useEffect(() => {
    if (!sourceKey || unreadable || found) return;
    const deadline = sentAt + DISCOVERY_WINDOW_MS;
    if (Date.now() >= deadline) return;
    const timer = setInterval(() => {
      if (Date.now() >= deadline) clearInterval(timer);
      else if (document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [sourceKey, unreadable, found, sentAt, refresh]);

  return { catalogue, failed: readState === 'failed', reload: refresh };
}
