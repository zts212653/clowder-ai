/**
 * F192 Phase G — Task Outcome Episode route handlers.
 *
 * These are pure functions that take a store + input and return results.
 * They are mounted onto Express routes in the main server file.
 *
 * Design principle: signals are appended to the active episode for a thread.
 * If no active episode exists, one is auto-created (trigger: cat_initiated).
 */
import type { CancelReason } from './task-outcome-episode.js';
import {
  buildA1WorldTruthSignal,
  buildMagicWordSignal,
  buildPermissionCancelSignal,
} from './task-outcome-signal-builder.js';
import type { StoredEpisode, TaskOutcomeEpisodeStore } from './task-outcome-store.js';

// ---- Result types ----

export interface SignalAppendResult {
  episodeId: string;
  signalAppended: boolean;
}

// ---- Input types ----

export interface PermissionCancelInput {
  toolName: string;
  paramsSummary?: string;
  reason?: CancelReason;
  catId: string;
  threadId: string;
  sessionId?: string;
}

export interface MagicWordInput {
  word: string;
  catId: string;
  threadId: string;
  precedingMessageSummary?: string;
  followingMessageSummary?: string;
}

export interface A1WorldTruthInput {
  type: 'merge' | 'revert' | 'test_pass' | 'test_fail' | 'build_pass' | 'build_fail';
  ref: string;
  outcome: 'success' | 'failure';
  threadId: string;
}

// ---- Assembled episode (with signals grouped) ----

export interface AssembledEpisode extends StoredEpisode {
  signals: {
    a1WorldTruth: Array<Record<string, unknown>>;
    a2InteractionDecisions: Array<Record<string, unknown>>;
    proxy: Array<Record<string, unknown>>;
  };
}

// ---- Helpers ----

function ensureActiveEpisode(store: TaskOutcomeEpisodeStore, threadId: string, catId?: string): StoredEpisode {
  const active = store.getActiveEpisode(threadId);
  if (active) return active;
  return store.createEpisode({
    trigger: 'cat_initiated',
    threadId,
    participants: catId ? [catId] : [],
  });
}

// ---- Handlers ----

export function handlePermissionCancel(
  store: TaskOutcomeEpisodeStore,
  input: PermissionCancelInput,
): SignalAppendResult {
  const episode = ensureActiveEpisode(store, input.threadId, input.catId);
  const signal = buildPermissionCancelSignal(input);
  store.appendSignal(episode.episodeId, {
    category: 'a2',
    record: signal as unknown as Record<string, unknown>,
  });
  return { episodeId: episode.episodeId, signalAppended: true };
}

// F227 归一 (superseded): magic words are captured by Event Memory
// (onMagicWordDetected → Event store, the single source of truth). The POST
// /api/task-outcome/magic-word route is deprecated and no longer calls this.
// Retained for the F192 owner to decide on removal — do NOT wire as a new writer.
export function handleMagicWord(store: TaskOutcomeEpisodeStore, input: MagicWordInput): SignalAppendResult {
  const episode = ensureActiveEpisode(store, input.threadId, input.catId);
  const signal = buildMagicWordSignal(input);
  store.appendSignal(episode.episodeId, {
    category: 'a2',
    record: signal as unknown as Record<string, unknown>,
  });
  return { episodeId: episode.episodeId, signalAppended: true };
}

export function handleA1WorldTruth(store: TaskOutcomeEpisodeStore, input: A1WorldTruthInput): SignalAppendResult {
  const episode = ensureActiveEpisode(store, input.threadId);
  const signal = buildA1WorldTruthSignal({
    type: input.type,
    ref: input.ref,
    outcome: input.outcome,
  });
  store.appendSignal(episode.episodeId, {
    category: 'a1',
    record: signal as unknown as Record<string, unknown>,
  });

  // Auto-complete on merge+success only.
  // revert is a strong NEGATIVE signal (plan: "revert → 任务失败") but does NOT
  // auto-close the episode — cat may redo work after revert. Terminal state
  // determination for non-merge events is left to eval cat or manual POST.
  if (episode.terminalState === 'in_progress' && input.type === 'merge' && input.outcome === 'success') {
    store.updateTerminalState(episode.episodeId, 'completed');
  }

  return { episodeId: episode.episodeId, signalAppended: true };
}

/**
 * F227 归一: project a stored a2 signal for the episode read-side. A
 * `magic_word_ref` (lightweight pointer to the Event Memory truth source) is
 * projected back to a `magic_word` entry so F192 eval keeps its a2 projection
 * contract (type:'magic_word' with word/timestamp/threadId/catId) WITHOUT having
 * to understand the Event schema. The eventId is preserved so consumers can fetch
 * full event detail (messageId, summaries, cognitiveTransition) on demand.
 */
function projectA2Signal(record: Record<string, unknown>): Record<string, unknown> {
  if (record.type === 'magic_word_ref') {
    return {
      type: 'magic_word',
      word: record.word,
      timestamp: record.timestamp,
      threadId: record.threadId,
      catId: record.catId,
      eventId: record.eventId,
    };
  }
  return record;
}

export function handleGetEpisode(store: TaskOutcomeEpisodeStore, episodeId: string): AssembledEpisode | null {
  const episode = store.getEpisode(episodeId);
  if (!episode) return null;

  const rawSignals = store.getSignals(episodeId);
  const a1WorldTruth: Array<Record<string, unknown>> = [];
  const a2InteractionDecisions: Array<Record<string, unknown>> = [];
  const proxy: Array<Record<string, unknown>> = [];

  for (const s of rawSignals) {
    switch (s.category) {
      case 'a1':
        a1WorldTruth.push(s.record);
        break;
      case 'a2':
        a2InteractionDecisions.push(projectA2Signal(s.record));
        break;
      case 'proxy':
        proxy.push(s.record);
        break;
    }
  }

  return {
    ...episode,
    signals: { a1WorldTruth, a2InteractionDecisions, proxy },
  };
}

export interface UpdateTerminalStateInput {
  episodeId: string;
  terminalState: 'completed' | 'abandoned' | 'escalated_cvo' | 'corrected_then_completed';
}

export function handleUpdateTerminalState(
  store: TaskOutcomeEpisodeStore,
  input: UpdateTerminalStateInput,
): StoredEpisode | null {
  const episode = store.getEpisode(input.episodeId);
  if (!episode) return null;
  store.updateTerminalState(input.episodeId, input.terminalState);
  return store.getEpisode(input.episodeId);
}

export function handleListEpisodes(store: TaskOutcomeEpisodeStore, threadId: string): StoredEpisode[] {
  return store.listByThread(threadId);
}
