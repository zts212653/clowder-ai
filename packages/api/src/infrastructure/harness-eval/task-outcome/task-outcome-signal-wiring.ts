/**
 * F192 Phase G AC-G11 — Production callback glue for task-outcome signals.
 *
 * Extracted from index.ts inline callbacks to make the production wiring
 * testable. index.ts calls these helpers; the e2e test verifies them directly.
 *
 * [宪宪/Opus-46🐾]
 */
import type { ManagedWorkBinding } from '@cat-cafe/shared';
import { buildA1WorldTruthSignal } from './task-outcome-signal-builder.js';
import type { EpisodeAttributionLookup, StoredEpisode, TaskOutcomeEpisodeStore } from './task-outcome-store.js';

interface EpisodeSelectionInput {
  threadId: string;
  participants: string[];
  managedWorkBinding?: ManagedWorkBinding;
  managedWorkExpected?: boolean;
  managedArtifactRef?: string;
}

function attributionLookup(input: EpisodeSelectionInput): EpisodeAttributionLookup {
  if (input.managedWorkBinding) {
    return {
      attribution: 'managed_attributed',
      workId: input.managedWorkBinding.workId,
      attemptId: input.managedWorkBinding.attemptId,
    };
  }
  if (input.managedWorkExpected) {
    if (!input.managedArtifactRef) {
      throw new Error('managed_unattributed episode lookup requires an artifact identity');
    }
    return { attribution: 'managed_unattributed', artifactRef: input.managedArtifactRef };
  }
  return { attribution: 'unmanaged_not_applicable', threadId: input.threadId };
}

function findActiveEpisode(store: TaskOutcomeEpisodeStore, input: EpisodeSelectionInput): StoredEpisode | null {
  return store.getActiveEpisodeByAttribution(attributionLookup(input));
}

function findOrCreateEpisode(store: TaskOutcomeEpisodeStore, input: EpisodeSelectionInput): StoredEpisode {
  const active = findActiveEpisode(store, input);
  if (active) return active;
  if (input.managedWorkBinding) {
    return store.createEpisode({
      trigger: 'task_created',
      threadId: input.threadId,
      participants: input.participants,
      attribution: 'managed_attributed',
      workId: input.managedWorkBinding.workId,
      attemptId: input.managedWorkBinding.attemptId,
    });
  }
  return store.createEpisode({
    trigger: input.managedWorkExpected ? 'task_created' : 'cat_initiated',
    threadId: input.threadId,
    participants: input.participants,
    ...(input.managedArtifactRef ? { artifacts: [input.managedArtifactRef] } : {}),
    attribution: input.managedWorkExpected ? 'managed_unattributed' : 'unmanaged_not_applicable',
  });
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
  const key = `mwr:${input.eventId}`;

  // Cross-episode dedup: if this eventId was already recorded in ANY episode,
  // skip entirely. Prevents phantom episode creation on event replay after
  // the original episode completes. (Day-24 verdict P1 — @gpt52 review)
  if (store.hasSignalByIdempotencyKey(key)) {
    return { episodeId: '', signalAppended: false };
  }

  const ep = findOrCreateEpisode(store, {
    threadId: input.threadId,
    participants: input.catId ? [input.catId] : [],
  });

  const result = store.appendSignal(ep.episodeId, {
    category: 'a2',
    record: {
      type: 'magic_word_ref',
      eventId: input.eventId,
      word: input.word,
      timestamp: new Date().toISOString(),
      threadId: input.threadId,
      catId: input.catId,
    },
    idempotencyKey: key,
  });

  return { episodeId: ep.episodeId, signalAppended: result.appended };
}

export interface PrLifecycleEvidenceInput {
  type: 'merge' | 'revert';
  ref: string;
  outcome: 'success' | 'failure';
  threadId: string;
  /** Read by CiCdRouter from TaskStore-private metadata. */
  managedWorkBinding?: ManagedWorkBinding;
}

/**
 * Append PR lifecycle evidence using only the server-private artifact binding.
 * A missing binding is an explicit coverage defect, never a thread-recency join.
 * Merge remains evidence and does not terminalize the work or Episode.
 */
export function appendPrLifecycleEvidenceToEpisode(
  store: TaskOutcomeEpisodeStore,
  input: PrLifecycleEvidenceInput,
): SignalWiringResult {
  const idempotencyKey = `pr:${input.type}:${input.ref}:${input.outcome}`;
  const existingEpisodeId = store.getSignalEpisodeIdByIdempotencyKey(idempotencyKey);
  if (existingEpisodeId) {
    return { episodeId: existingEpisodeId, signalAppended: false };
  }

  const episode = findOrCreateEpisode(store, {
    threadId: input.threadId,
    participants: [],
    managedWorkExpected: true,
    managedArtifactRef: input.ref,
    ...(input.managedWorkBinding ? { managedWorkBinding: input.managedWorkBinding } : {}),
  });
  const signal = buildA1WorldTruthSignal({ type: input.type, ref: input.ref, outcome: input.outcome });
  const result = store.appendSignal(episode.episodeId, {
    category: 'a1',
    record: signal as unknown as Record<string, unknown>,
    idempotencyKey,
  });
  return { episodeId: episode.episodeId, signalAppended: result.appended };
}
