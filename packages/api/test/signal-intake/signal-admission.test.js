import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemorySignalIngressTraceSink, SignalAdmissionError } from '../../dist/domains/signal-intake/index.js';
import { admissionHarness, publishInput } from './helpers.js';

describe('F292 Host signal admission', () => {
  it('atomically creates one intake and returns the stable receipt on exact redelivery', async () => {
    const { binding, intakes, service } = await admissionHarness();
    const accepted = await service.publish(binding, publishInput());
    const duplicate = await service.publish(binding, publishInput());

    assert.deepEqual(accepted, { publicationId: 'pub-1', disposition: 'accepted' });
    assert.deepEqual(duplicate, { publicationId: 'pub-1', disposition: 'duplicate' });
    const records = await intakes.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].intakeId, 'intake-1');
    assert.equal(records[0].source.handle, 'example://meeting/artifact-1');
    assert.equal(records[0].judgmentState, 'unresolved');
    assert.deepEqual(records[0].unresolved, ['speakers', 'context', 'destination', 'outputs']);
  });

  it('fails closed on same identity with different content or a second key for the same source', async () => {
    const { binding, intakes, service } = await admissionHarness();
    await service.publish(binding, publishInput());

    await assert.rejects(
      service.publish(binding, publishInput({ payload: { artifactId: 'artifact-1', title: 'Changed' } })),
      (error) => error instanceof SignalAdmissionError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      service.publish(binding, publishInput({ eventId: 'evt-2', idempotencyKey: 'other-key' })),
      (error) => error instanceof SignalAdmissionError && error.code === 'SOURCE_IDENTITY_CONFLICT',
    );
    assert.equal((await intakes.list()).length, 1);
  });

  it('uses the installed payload schema and rejects transcripts and plugin-selected destinations', async () => {
    const traces = new MemorySignalIngressTraceSink();
    const { binding, intakes, service } = await admissionHarness({ traces });
    await assert.rejects(
      service.publish(binding, publishInput({ payload: { artifactId: 'artifact-1', transcript: 'private' } })),
      (error) => error instanceof SignalAdmissionError && error.code === 'INVALID_SIGNAL',
    );
    await assert.rejects(
      service.publish(binding, { ...publishInput(), destination: { threadId: 'thread-1' } }),
      (error) => error instanceof SignalAdmissionError && error.code === 'INVALID_SIGNAL',
    );
    assert.equal((await intakes.list()).length, 0);
    const serialized = JSON.stringify(traces.traces);
    assert.equal(serialized.includes('private'), false);
    assert.equal(serialized.includes('transcript'), false);
    assert.deepEqual(
      traces.traces.map((trace) => trace.rejectionCode),
      ['INVALID_SIGNAL', 'INVALID_SIGNAL'],
    );
  });

  it('binds package, grant, live runtime lease, and Host route generation', async () => {
    const { binding, controlPlane, intakes, runtimeLeases, service } = await admissionHarness();
    await assert.rejects(
      service.publish({ ...binding, packageDigest: `sha512-${'A'.repeat(88)}` }, publishInput()),
      (error) => error instanceof SignalAdmissionError && error.code === 'AUTHORITY_MISMATCH',
    );
    runtimeLeases.put({ ...(await runtimeLeases.get('lease-1')), expiresAt: 9_999 });
    await assert.rejects(
      service.publish(binding, publishInput()),
      (error) => error instanceof SignalAdmissionError && error.code === 'RUNTIME_LEASE_EXPIRED',
    );
    runtimeLeases.put({ ...(await runtimeLeases.get('lease-1')), expiresAt: 20_000 });
    await controlPlane.revokeGrant({
      pluginInstanceId: 'pi_example',
      capability: 'events.publish',
      expectedGrantRevision: 1,
    });
    await assert.rejects(
      service.publish(binding, publishInput()),
      (error) => error instanceof SignalAdmissionError && error.code === 'STALE_GRANT',
    );
    assert.equal((await intakes.list()).length, 0);
  });
});
