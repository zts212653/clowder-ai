import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveLegacyPawFeelBlockerReopenEventId,
  digestLegacyPawFeelBlockerEvent,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/blocker-reopen-identity.js';
import { derivePawFeelBlockerReopenEventId } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/resume-condition.js';
import { PawFeelDispositionService } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';
import {
  MemoryPawFeelEventLog,
  pawFeelCandidate,
  pawFeelCommand,
} from './helpers/paw-feel-disposition-service-fixture.js';

describe('F313 blocker reopen service boundary', () => {
  it('rejects caller-authored condition reopen truth before append', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    const taskRef = { ownerFeatureId: 'F310', ownerStateRef: 'task:item:service-boundary' };
    let resolverCalls = 0;
    const service = new PawFeelDispositionService({
      eventLog,
      resumeConditionResolver: {
        async resolve(selector) {
          resolverCalls += 1;
          return {
            normalizedSelector: selector,
            state: 'waiting',
            version: 'canonical-v1',
            satisfied: false,
            evidenceRefs: [{ ...taskRef, version: 'canonical-v1' }],
          };
        },
      },
      now: () => '2026-09-07T00:00:00.000Z',
    });
    const source = pawFeelCandidate({ messageId: 'condition-service-boundary', digest: 'b'.repeat(64) });
    await service.discover(source, { backfilled: false });
    const blocked = await service.execute(
      { kind: 'cat', id: 'opus' },
      pawFeelCommand('mark_blocked', source.signalId, 1, {
        blockerCode: 'task_wait',
        blockerRef: taskRef.ownerStateRef,
        resume: { kind: 'task', ref: taskRef },
      }),
    );
    const condition = blocked.projection.blocker?.resumeCondition;
    assert.ok(condition);

    const forgedResumeVersion = 'f'.repeat(64);
    await assert.rejects(
      service.reopenBlocker({
        eventId: derivePawFeelBlockerReopenEventId({
          signalId: source.signalId,
          conditionId: condition.conditionId,
          blockedVersion: condition.blockedVersion,
          resumeVersion: forgedResumeVersion,
        }),
        signalId: source.signalId,
        expectedSequence: 2,
        occurredAt: '2026-09-07T00:01:00.000Z',
        reopen: {
          kind: 'condition',
          conditionId: condition.conditionId,
          blockedVersion: condition.blockedVersion,
          resumeVersion: forgedResumeVersion,
          reason: 'condition_changed',
          evidenceRefs: [],
        },
      }),
      /condition reopen must be derived by the disposition service/i,
    );

    assert.equal(resolverCalls, 1, 'the forged call must not become a second resolver authority');
    assert.equal((await eventLog.read(source.signalId)).length, 2);
  });

  it('rejects direct legacy mutation without authority or the exact blocker digest', async () => {
    const eventLog = new MemoryPawFeelEventLog();
    const source = pawFeelCandidate();
    const service = new PawFeelDispositionService({ eventLog, now: () => '2026-09-07T00:00:00.000Z' });
    await service.discover(source, { backfilled: true });
    const blockedEvent = {
      eventId: 'legacy:block',
      signalId: source.signalId,
      type: 'blocked',
      actor: { kind: 'cat', id: 'opus' },
      occurredAt: '2026-09-07T00:00:01.000Z',
      blockerCode: 'legacy_wait',
      blockerRef: 'legacy:one',
    };
    await eventLog.append(blockedEvent, 1);

    const manifestDigest = 'a'.repeat(64);
    const blockerEventDigest = digestLegacyPawFeelBlockerEvent(blockedEvent);
    const command = (digest) => ({
      eventId: deriveLegacyPawFeelBlockerReopenEventId({
        signalId: source.signalId,
        blockingSequence: 2,
        blockerEventDigest: digest,
        manifestDigest,
      }),
      signalId: source.signalId,
      expectedSequence: 2,
      occurredAt: '2026-09-07T00:00:02.000Z',
      reopen: { kind: 'legacy_unbound', blockingSequence: 2, blockerEventDigest: digest, manifestDigest },
    });

    await assert.rejects(service.reopenBlocker(command(blockerEventDigest)), /production-data authorization/i);
    await assert.rejects(
      service.reopenBlocker({ ...command('f'.repeat(64)), productionDataAuthorizationRef: 'cvo:approved' }),
      /blocker event digest/i,
    );
    assert.equal((await eventLog.read(source.signalId)).length, 2);
  });
});
