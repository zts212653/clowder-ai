/**
 * F257 #2 — native-L0 session trace persistence (shared by route-serial + route-parallel).
 *
 * Persists the L1-L7 session trace from the ACTUAL L0 compiler manifest
 * (`getL0ManifestViaSubprocess`), bridged through the existing `buildFromPipeline`.
 *
 * Start this without awaiting so compilation never taxes the model critical path, then
 * await the returned completion at the terminal seam before closing the episode. The manifest
 * is cache-first; a cold cache shares the provider's
 * own compile via the l0-compiler in-flight dedup — no redundant full-stage run. An empty
 * manifest emits a visible producer warning rather than silently persisting D-only, so
 * "L 系列无数据" is distinguishable from a healthy zero.
 *
 * Centralizing here (vs. inlining in two large route functions) is also sol 2b R1 P2-2:
 * one producer seam, unit-testable without driving a whole route.
 */

import type { ReplayProvenanceGap } from '@cat-cafe/shared';
import { getL0ManifestViaSubprocess } from '../cats/services/agents/providers/l0-compiler.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { PipelineResult } from './HookPipeline.js';
import type { InjectionTraceStore } from './InjectionTraceStore.js';
import { l0ManifestToSessionResult, validateL0Manifest } from './l0-manifest-trace.js';
import { buildFromPipeline, buildReplaySnapshots, captureSurroundingMessageIds } from './trace-bridge.js';

interface TraceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PersistNativeL0Params {
  traceStore: InjectionTraceStore;
  catId: string;
  threadId: string;
  turnId: string;
  /** The already-drained per-turn (D-series) pipeline trace for this invocation. */
  turnResult: PipelineResult | null;
  log: TraceLogger;
  /** F257 Console 判据④：owner-scoped replay snapshot context. */
  ownerUserId: string;
  messageAnchorId: string | null;
  messageStore?: IMessageStore;
}

export async function persistNativeL0SessionTrace(params: PersistNativeL0Params): Promise<boolean> {
  const { traceStore, catId, threadId, turnId, turnResult, log, ownerUserId, messageAnchorId, messageStore } = params;
  try {
    // R2 P1-2: pass ownerUserId so the manifest cache keys by the invocation's
    // actual owner — prevents cross-user L0 content leaking into another owner's trace.
    const manifest = await getL0ManifestViaSubprocess({ catId, userId: ownerUserId });
    // 2b R2 P1-1: reject the manifest atomically. A partial/foreign/blank/reordered manifest
    // is a producer regression — surface WHY (visible signal), never persist a partial success.
    const rejectReason = validateL0Manifest(manifest);
    if (rejectReason) {
      log.warn(
        { catId, threadId, reason: rejectReason },
        '[F257] native L0 manifest rejected — L1-L7 not observed this turn (producer signal)',
      );
      // R3 P1: invalid manifest → return false immediately. Do NOT persist a D-only
      // partial trace via buildFromPipeline(null, turnResult) — that creates an evaluable
      // terminal without authority L1-L7 segments, violating the measurement-unit boundary.
      return false;
    }
    const sessionResult = l0ManifestToSessionResult(manifest); // non-null (validated above)
    const bridge = buildFromPipeline(sessionResult, turnResult, {
      turnId,
      threadId,
      catId,
      hasNativeL0: true,
      sessionFromNativeCompiler: sessionResult !== null,
    });
    if (bridge) {
      await traceStore.persist(bridge.summary, bridge.detail);
      // Capture event-time context inside the fire-and-forget persistence path so it does not
      // block the model critical path (sol R3 P2).
      const surroundingCapture = messageStore
        ? await captureSurroundingMessageIds(messageStore, threadId, messageAnchorId, ownerUserId)
        : { ids: [], gap: 'unavailable' as ReplayProvenanceGap };
      const snapshots = buildReplaySnapshots(sessionResult, turnResult, {
        threadId,
        turnId,
        catId,
        timestamp: bridge.detail.timestamp,
        ownerUserId,
        messageAnchorId,
        surroundingMessageIds: surroundingCapture.ids,
        surroundingMessagesGap: surroundingCapture.gap,
      });
      try {
        await traceStore.persistReplaySnapshots(threadId, turnId, snapshots);
      } catch (err) {
        // Replay context is additive. The durable summary is sufficient to close the
        // episode and must not be discarded when a legacy/test Redis lacks EVAL.
        log.warn(
          { err: err instanceof Error ? err.message : String(err), catId, threadId },
          '[F257] native L0 replay snapshots failed after trace summary persisted',
        );
      }
      return true;
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), catId, threadId },
      '[F257] native L0 session trace failed (fire-and-forget)',
    );
  }
  return false;
}
