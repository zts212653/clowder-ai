import { createHash } from 'node:crypto';
import type { BallCustodyEvent, BallCustodyProjection } from '@cat-cafe/shared';
import { reduceBallCustodyEvent } from './ball-custody-projection-reducer.js';

const projectionVersion = (projection: BallCustodyProjection | null) =>
  createHash('sha256').update(JSON.stringify(projection)).digest('hex');

import { ballEventFingerprint } from './ball-event-fingerprint.js';
import { BallProbeRecoveryConflict, type BallRecoveryBackend } from './ball-probe-recovery-backend.js';
import { reconcileBallProbeFacts } from './ball-probe-recovery-state.js';

/** Exact-event projection debt/receipt belongs to the existing EventLog subject metadata. */
export class BallProjectionCommitOwner {
  constructor(private readonly backend: BallRecoveryBackend) {}
  async prepare(event: BallCustodyEvent): Promise<boolean> {
    const key = `projectionIntent:${event.sourceEventId}`;
    if (await this.backend.readArchive(event.subjectKey, `projectionReceipt:${event.sourceEventId}`)) return true;
    if (await this.backend.readArchive(event.subjectKey, key))
      return (
        (await this.backend.readArchive(event.subjectKey, `projectionNative:${event.sourceEventId}`)) ===
        ballEventFingerprint(event)
      );
    try {
      await this.backend.mutate(event.subjectKey, ({ projection, facts }) => {
        if (facts.rebuilding) throw new BallProbeRecoveryConflict('projection_rebuild_in_progress');
        return {
          result: undefined,
          requireArchiveAbsent: key,
          archive: {
            [key]: JSON.stringify({
              fingerprint: ballEventFingerprint(event),
              beforeHash: projectionVersion(projection),
            }),
          },
        };
      });
    } catch (error) {
      if (!(error instanceof BallProbeRecoveryConflict) || !(await this.backend.readArchive(event.subjectKey, key)))
        throw error;
      return (
        (await this.backend.readArchive(event.subjectKey, `projectionNative:${event.sourceEventId}`)) ===
        ballEventFingerprint(event)
      );
    }
    return false;
  }
  async acknowledgeRebuild(event: BallCustodyEvent): Promise<void> {
    await this.backend.mutate(event.subjectKey, () => ({
      result: undefined,
      archive: { [`projectionReceipt:${event.sourceEventId}`]: ballEventFingerprint(event) },
    }));
  }
  async commit(event: BallCustodyEvent): Promise<void> {
    const receipt = `projectionReceipt:${event.sourceEventId}`,
      fingerprint = ballEventFingerprint(event);
    const proof = await this.backend.readArchive(event.subjectKey, receipt);
    if ((await this.backend.readFacts(event.subjectKey))?.rebuilding)
      throw new BallProbeRecoveryConflict('projection_rebuild_in_progress');
    if (proof) {
      if (proof !== fingerprint) throw new Error('projection_event_identity_conflict');
      return;
    }
    const raw = await this.backend.readArchive(event.subjectKey, `projectionIntent:${event.sourceEventId}`);
    if (!raw) throw new Error('projection_event_intent_unavailable');
    const intent = JSON.parse(raw) as { fingerprint: string; beforeHash: string };
    if (intent.fingerprint !== fingerprint) throw new Error('projection_event_identity_conflict');
    try {
      await this.backend.mutate(event.subjectKey, ({ projection, facts }) => {
        if (facts.rebuilding || projectionVersion(projection) !== intent.beforeHash)
          throw new BallProbeRecoveryConflict('projection_event_source_changed');
        const after = reduceBallCustodyEvent(projection, event).after;
        return {
          result: undefined,
          mode: 'write',
          projection: after,
          requireArchiveAbsent: receipt,
          facts: reconcileBallProbeFacts(event.subjectKey, after, facts),
          archive: { [receipt]: fingerprint },
        };
      });
    } catch (error) {
      // A response lost after the atomic publication is an exact replay, not a second reduction.
      if ((await this.backend.readArchive(event.subjectKey, receipt)) === fingerprint) return;
      throw error;
    }
  }
}
