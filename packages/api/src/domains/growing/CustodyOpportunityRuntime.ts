import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import { CustodyOpportunityCohortStore, type CustodyOpportunityRead } from './CustodyOpportunityCohortStore.js';
import {
  CustodyOpportunityCohortInvalidError,
  CustodyOpportunityEpisodeRecorder,
} from './CustodyOpportunityEpisodeRecorder.js';
import { projectCustodyOpportunity } from './CustodyOpportunitySourceProjection.js';

export interface CustodyOpportunityRuntimeDeps {
  readonly cohorts: CustodyOpportunityCohortStore;
  readonly messages: Required<Pick<IMessageStore, 'listOwnerMessageWindowSlice'>>;
  readonly tasks: Pick<ITaskStore, 'listByKind'>;
  readonly policyVersion: string;
  readonly now?: () => number;
}

/** Runtime reads actual canonical sources selected by a registration that predates those sources. */
export class CustodyOpportunityRuntime {
  private readonly now: () => number;
  constructor(private readonly deps: CustodyOpportunityRuntimeDeps) {
    this.now = deps.now ?? Date.now;
  }

  register(ownerUserId: string) {
    return this.deps.cohorts.ensure(ownerUserId, this.deps.policyVersion, this.now());
  }

  async read(ownerUserId: string): Promise<CustodyOpportunityRead> {
    const cohort = this.register(ownerUserId);
    const capturedAt = this.now();
    const observationCutoff = Math.min(capturedAt, cohort.reviewAt);
    const [sourceSlice, tasks] = await Promise.all([
      this.deps.messages.listOwnerMessageWindowSlice(ownerUserId, cohort.startedAt, observationCutoff, 5_000),
      this.deps.tasks.listByKind('work'),
    ]);
    const recorder = new CustodyOpportunityEpisodeRecorder();
    const coverageGaps: { sourceRef: string; reason: string }[] = [];
    if (sourceSlice.hasMore) coverageGaps.push({ sourceRef: cohort.cohortRef, reason: 'source_window_capped' });
    for (const source of sourceSlice.messages.sort((a, b) => a.id.localeCompare(b.id))) {
      const projected = projectCustodyOpportunity(source, tasks, cohort, capturedAt);
      if (projected.kind === 'gap') {
        coverageGaps.push({ sourceRef: projected.sourceRef, reason: projected.reason });
        continue;
      }
      if (projected.kind === 'excluded') continue;
      try {
        recorder.record(projected.episode);
      } catch (error) {
        if (!(error instanceof CustodyOpportunityCohortInvalidError)) throw error;
      }
    }
    const measurement = recorder.snapshot();
    return {
      cohort,
      capturedAt,
      observationCutoff,
      reviewSnapshotRef: this.deps.cohorts.reviewRef(cohort.cohortRef),
      coverageGaps,
      measurement,
      readiness: readReviewReadiness(cohort, capturedAt, coverageGaps, measurement),
      actionability: 'requires_independent_calibration_and_cvo_outcome',
    };
  }

  async freeze(ownerUserId: string) {
    const snapshot = await this.read(ownerUserId);
    return { snapshotRef: this.deps.cohorts.save(snapshot), snapshot };
  }

  readFrozen(ownerUserId: string, snapshotRef: string) {
    return this.deps.cohorts.readSnapshot(ownerUserId, snapshotRef);
  }

  async reconcile(ownerUserId: string) {
    const snapshot = await this.read(ownerUserId);
    if (
      snapshot.readiness === 'needs_calibration' ||
      snapshot.capturedAt >= snapshot.cohort.reviewAt ||
      snapshot.measurement.state === 'invalid'
    ) {
      return this.deps.cohorts.captureReviewOnce(snapshot);
    }
    return null;
  }
}

function readReviewReadiness(
  cohort: CustodyOpportunityRead['cohort'],
  capturedAt: number,
  coverageGaps: CustodyOpportunityRead['coverageGaps'],
  measurement: CustodyOpportunityRead['measurement'],
): CustodyOpportunityRead['readiness'] {
  if (coverageGaps.length || measurement.state === 'invalid') return 'insufficient_evidence';
  const mature = measurement.episodes.filter((episode) => episode.delayedOutcome.state !== 'pending');
  const enough =
    mature.length >= 20 &&
    mature.filter((episode) => episode.window.kind === 'sampled_silent').length >= 5 &&
    mature.filter((episode) => episode.policyDisposition === 'offer').length >= 5;
  if (enough) return 'needs_calibration';
  return capturedAt >= cohort.reviewAt ? 'insufficient_evidence' : 'collecting';
}

/** Pin the actual recognition code and skill bytes; a changed policy starts a fresh prospective cohort. */
export async function custodyRecognitionPolicyVersion(repoRoot: string): Promise<string> {
  const files = await Promise.all([
    readFile(new URL('../cats/services/context/IntentParser.js', import.meta.url)),
    readFile(new URL('./CustodyOfferService.js', import.meta.url)),
    readFile(new URL('./CustodyOpportunitySourceProjection.js', import.meta.url)),
    readFile(new URL('./EntrustedWorkSourceSignals.js', import.meta.url)),
    readFile(join(repoRoot, 'cat-cafe-skills/custody-recognition/SKILL.md')),
  ]);
  const hash = createHash('sha256');
  for (const file of files) hash.update(String(file.length)).update('\0').update(file);
  return `custody-recognition-v1:${hash.digest('hex')}`;
}

/** Event and time use one coalesced observer. A review receipt requests calibration, never product action. */
export function startCustodyOpportunityObservation(input: {
  runtime: CustodyOpportunityRuntime;
  ownerUserId: string;
  onError: (error: unknown) => void;
  onReviewDue: (snapshotRef: string) => void;
  intervalMs?: number;
}) {
  input.runtime.register(input.ownerUserId);
  let inFlight: Promise<void> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reportedRef: string | null = null;
  const reconcile = () => {
    if (closed || inFlight) return;
    inFlight = input.runtime
      .reconcile(input.ownerUserId)
      .then((ref) => {
        if (ref && ref !== reportedRef) {
          reportedRef = ref;
          input.onReviewDue(ref);
        }
      })
      .catch(input.onError)
      .finally(() => {
        inFlight = undefined;
      });
  };
  const timer = setInterval(reconcile, input.intervalMs ?? 60_000);
  timer.unref();
  return {
    notifySourceChanged(message: StoredMessage) {
      if (closed || message.userId !== input.ownerUserId || eventTimer) return;
      eventTimer = setTimeout(() => {
        eventTimer = undefined;
        reconcile();
      }, 1_000);
      eventTimer.unref();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      if (eventTimer) clearTimeout(eventTimer);
      await inFlight;
    },
  };
}
