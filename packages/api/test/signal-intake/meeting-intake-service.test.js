import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { meetingIntakeNeedsAttention } from '@cat-cafe/shared';
import {
  MeetingIntakeError,
  MeetingIntakeService,
  MemoryDestinationAuthority,
} from '../../dist/domains/signal-intake/index.js';
import { admissionHarness, publishInput } from './helpers.js';

async function harness() {
  const admission = await admissionHarness();
  await admission.service.publish(admission.binding, publishInput());
  const destinations = new MemoryDestinationAuthority();
  destinations.put({ handle: 'host:private-thread:thread-1', kind: 'private-thread', targetId: 'thread-1' });
  const service = new MeetingIntakeService(admission.intakes, destinations, { now: () => 11_000 });
  return { ...admission, destinations, service };
}

describe('F292 MeetingIntake state truth', () => {
  it('confirms human choices on the same revisioned record and queues execution', async () => {
    const { intakes, service } = await harness();
    const confirmed = await service.confirm('intake-1', 1, {
      speakerMap: { 1: 'You' },
      context: 'Architecture review',
      destinationHandle: 'host:private-thread:thread-1',
      outputs: ['minutes', 'roadmap'],
    });
    assert.equal(confirmed.revision, 2);
    assert.equal(confirmed.judgmentState, 'confirmed');
    assert.equal(confirmed.executionState, 'queued');
    assert.deepEqual(confirmed.unresolved, []);
    assert.equal(meetingIntakeNeedsAttention(confirmed), false);
    assert.equal((await intakes.get('intake-1')).intakeId, 'intake-1');
  });

  it('rejects stale actions and unavailable F290 Channel destinations', async () => {
    const { service } = await harness();
    await assert.rejects(
      service.confirm('intake-1', 1, {
        speakerMap: { 1: 'You' },
        context: 'Context',
        destinationHandle: 'host:channel:f290-missing',
        outputs: ['minutes'],
      }),
      (error) => error instanceof MeetingIntakeError && error.code === 'DESTINATION_UNAVAILABLE',
    );
    await service.dismiss('intake-1', 1);
    await assert.rejects(
      service.dismiss('intake-1', 1),
      (error) => error instanceof MeetingIntakeError && error.code === 'REVISION_CONFLICT',
    );
  });

  it('projects every degraded source state with a concrete repair action', async () => {
    const cases = [
      ['transcript_not_ready', 'not_ready', 'retry'],
      ['auth_required', 'auth_required', 'regrant'],
      ['source_deleted', 'deleted', 'manual_import'],
    ];
    for (const [code, sourceState, action] of cases) {
      const { service } = await harness();
      const degraded = await service.markRepair('intake-1', 1, { code, safeDetail: 'bounded' });
      assert.equal(degraded.sourceState, sourceState);
      assert.equal(degraded.healthState, 'degraded');
      assert.equal(degraded.repair.action, action);
      assert.equal(meetingIntakeNeedsAttention(degraded), true);
    }
  });
});
