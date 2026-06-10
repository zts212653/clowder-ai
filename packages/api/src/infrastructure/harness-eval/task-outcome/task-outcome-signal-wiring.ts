/**
 * F192 Phase G AC-G11 — Production callback glue for task-outcome signals.
 *
 * Extracted from index.ts inline callbacks to make the production wiring
 * testable. index.ts calls these helpers; the e2e test verifies them directly.
 *
 * [宪宪/Opus-46🐾]
 */
import type { CancelBurstDetector } from './cancel-burst-detector.js';
import { CANCEL_REASONS, type CancelReason } from './task-outcome-episode.js';
import { buildPermissionCancelSignal } from './task-outcome-signal-builder.js';
import type { TaskOutcomeEpisodeStore } from './task-outcome-store.js';

// ---- Permission cancel + reason normalization → episode a2 signal ----

export interface PermissionCancelWiringInput {
  toolName: string;
  paramsSummary?: string;
  /** Raw cancel reason from frontend; normalized to CancelReason enum (default: 'skip'). */
  cancelReason?: string;
  catId?: string;
  threadId: string;
  sessionId?: string;
}

/**
 * Normalize the cancel reason, get/create the active episode, and append
 * a `permission_cancel` a2 signal. This is the production path called by
 * index.ts onPermissionCancel (authorization callback).
 *
 * Reason normalization: if `cancelReason` is not a valid CancelReason enum
 * value, defaults to 'skip' (auth free-text is not a cancel category).
 */
export function appendPermissionCancelToEpisode(
  store: TaskOutcomeEpisodeStore,
  input: PermissionCancelWiringInput,
): SignalWiringResult {
  const reason: CancelReason =
    input.cancelReason && (CANCEL_REASONS as readonly string[]).includes(input.cancelReason)
      ? (input.cancelReason as CancelReason)
      : 'skip';

  const catId = input.catId ?? 'unknown';
  const ep =
    store.getActiveEpisode(input.threadId) ??
    store.createEpisode({
      trigger: 'cat_initiated',
      threadId: input.threadId,
      participants: [catId],
    });

  const signal = buildPermissionCancelSignal({
    toolName: input.toolName,
    paramsSummary: input.paramsSummary,
    reason,
    catId,
    threadId: input.threadId,
    sessionId: input.sessionId,
  });

  store.appendSignal(ep.episodeId, {
    category: 'a2',
    record: signal as unknown as Record<string, unknown>,
  });

  return { episodeId: ep.episodeId, signalAppended: true };
}

// ---- Magic word ref → episode signal ----

export interface MagicWordRefInput {
  eventId: string;
  word: string;
  threadId: string;
  catId: string;
}

export interface SignalWiringResult {
  episodeId: string;
  signalAppended: boolean;
}

/**
 * Append a `magic_word_ref` a2 signal to the active episode for a thread.
 * Auto-creates an episode if none exists (trigger: cat_initiated).
 *
 * This is the F227 归一 production path: Event Memory is the truth source,
 * episode stores a lightweight ref. Extracted from index.ts onMagicWordDetected.
 */
export function appendMagicWordRefToEpisode(
  store: TaskOutcomeEpisodeStore,
  input: MagicWordRefInput,
): SignalWiringResult {
  const ep =
    store.getActiveEpisode(input.threadId) ??
    store.createEpisode({
      trigger: 'cat_initiated',
      threadId: input.threadId,
      participants: input.catId ? [input.catId] : [],
    });

  store.appendSignal(ep.episodeId, {
    category: 'a2',
    record: {
      type: 'magic_word_ref',
      eventId: input.eventId,
      word: input.word,
      timestamp: new Date().toISOString(),
      threadId: input.threadId,
      catId: input.catId,
    },
  });

  return { episodeId: ep.episodeId, signalAppended: true };
}

// ---- Cancel burst check → proxy signal ----

export interface CancelBurstCheckResult {
  burst: boolean;
  count: number;
  episodeId?: string;
  proxyAppended: boolean;
}

/**
 * Record a cancel event in the burst detector and, if a burst is detected,
 * append a `cancel_burst` proxy signal to the active episode.
 *
 * Extracted from index.ts onPermissionCancel authorization handler.
 */
export function checkAndAppendCancelBurst(
  store: TaskOutcomeEpisodeStore,
  burstDetector: CancelBurstDetector,
  threadId: string,
  timestamp: number,
): CancelBurstCheckResult {
  const burstResult = burstDetector.record(threadId, timestamp);

  if (!burstResult.burst) {
    return { burst: false, count: burstResult.count, proxyAppended: false };
  }

  const ep = store.getActiveEpisode(threadId);
  if (!ep) {
    return { burst: true, count: burstResult.count, proxyAppended: false };
  }

  store.appendSignal(ep.episodeId, {
    category: 'proxy',
    record: {
      type: 'cancel_burst',
      value: burstResult.count,
      timestamp: new Date(timestamp).toISOString(),
      threadId,
    },
  });

  return { burst: true, count: burstResult.count, episodeId: ep.episodeId, proxyAppended: true };
}
