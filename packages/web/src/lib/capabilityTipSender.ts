/**
 * F268 — Authenticated sender connecting TipEventQueue → POST /api/tip-telemetry/batch.
 *
 * Non-blocking: queue calls this async; failures trigger retry via queue's backoff logic.
 * Auto-initializes on first import by wiring the sender to the queue singleton.
 * Session auth is delegated to the shared apiFetch client. It bootstraps the
 * cookie and retries one 401 after API restarts before queue backoff is consumed.
 */

import type { TipEventBatch, TipEventBatchAck } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import type { TipEventSender } from './capabilityTipQueue';
import { getTipEventQueue } from './capabilityTipQueue';

/**
 * Create a sender that POSTs batches to the tip-telemetry API endpoint.
 * Uses the shared session-refreshing API client so a stale cookie is repaired
 * before the queue spends one of its bounded transport retries.
 *
 * Exported for testing (Sol R2 P1-3): inject a mocked request client to verify status classification:
 * - 202 → resolves (accepted)
 * - 409 → resolves (conflict, no retry)
 * - 401 → throws (retry via backoff)
 * - other 4xx → resolves (dead-letter)
 * - 5xx → throws (retry)
 */
export function createTipEventSender(requestImpl: typeof apiFetch = apiFetch): TipEventSender {
  return async (batch: TipEventBatch) => {
    const response = await requestImpl('/api/tip-telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });

    if (response.status === 202) {
      const ack: TipEventBatchAck = await response.json();
      return { accepted: ack.accepted, rejected: ack.rejected };
    }

    if (response.status === 409) {
      // Payload conflict — client bug, don't retry
      const ack: TipEventBatchAck = await response.json();
      return { accepted: 0, rejected: ack.rejected };
    }

    if (response.status === 401) {
      // apiFetch already bootstrapped the session and retried once. A persistent
      // 401 remains retryable, but must not clear the queue as a false ACK.
      throw new Error(`Tip telemetry auth not ready: ${response.status}`);
    }

    if (response.status >= 400 && response.status < 500) {
      // Non-auth client error (schema validation) — dead-letter, don't retry
      return { accepted: 0, rejected: batch.events.length };
    }

    // 5xx or network error — throw to trigger queue retry
    throw new Error(`Tip telemetry upload failed: ${response.status}`);
  };
}

// ── Auto-initialization ────────────────────────────────────────────────────
// Wire sender to queue singleton on first import. The queue accumulates events
// even before this runs (enqueue is non-blocking); setSender triggers flush of
// any accumulated events.

getTipEventQueue().setSender(createTipEventSender());
