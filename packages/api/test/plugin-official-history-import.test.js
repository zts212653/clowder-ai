import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OfficialPluginHistoryImportError, OfficialPluginHistoryImportService } from '../dist/domains/plugin/index.js';
import { entry, harness } from './plugin-official-routes.fixture.js';

async function serviceHarness(overrides = {}) {
  const routeHarness = await harness();
  await routeHarness.store.transaction((transaction) => {
    const instance = transaction.instances.get('pi_official');
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
      lifecycleRevision: 7,
    });
  });
  const published = [];
  const descriptor = {
    artifactId: 'obcne9c5d9z4l3o3nk9mg777',
    kind: 'minute',
    revision: '7674075151507852250',
    generatedAt: '2026-08-14T18:44:10.000Z',
    title: 'AI创新项目招人及运营规划',
  };
  const signal = {
    signalType: 'feishu.meeting_artifact.generated.v1',
    eventId: 'feishu-minute-obcne9c5d9z4l3o3nk9mg777-v7674075151507852250',
    idempotencyKey: 'feishu:minute:obcne9c5d9z4l3o3nk9mg777:7674075151507852250',
    occurredAt: descriptor.generatedAt,
    payload: {
      artifactId: descriptor.artifactId,
      artifactKind: 'minute',
      revision: descriptor.revision,
      title: descriptor.title,
    },
    source: {
      handle: 'feishu://meeting-artifacts/minute/obcne9c5d9z4l3o3nk9mg777?revision=7674075151507852250',
    },
  };
  const service = new OfficialPluginHistoryImportService({
    inventory: routeHarness.store,
    broker: overrides.broker ?? {
      publishOwnerImportedSignal: async (instanceId, input) => {
        published.push({ instanceId, input });
        return { publicationId: 'pub-history', disposition: 'accepted' };
      },
    },
    parseReference: overrides.parseReference ?? (() => ({ artifactId: descriptor.artifactId, kind: 'minute' })),
    inspectArtifact: overrides.inspectArtifact ?? (async () => descriptor),
    normalizeArtifact: overrides.normalizeArtifact ?? (() => signal),
  });
  const snapshot = await routeHarness.store.snapshot();
  return {
    ...routeHarness,
    descriptor,
    input: {
      entry,
      instance: snapshot.instances[0],
      expectedRevision: 7,
      reference: descriptor.artifactId,
    },
    published,
    service,
    signal,
  };
}

test('historical import inspects and normalizes the owner reference before durable Broker admission', async () => {
  const parsed = [];
  const inspected = [];
  const normalized = [];
  const fixture = await serviceHarness({
    parseReference: (reference) => {
      parsed.push(reference);
      return { artifactId: reference, kind: 'minute' };
    },
    inspectArtifact: async (locator, signal) => {
      inspected.push({ locator, aborted: signal.aborted });
      return fixture.descriptor;
    },
    normalizeArtifact: (descriptor) => {
      normalized.push(descriptor);
      return fixture.signal;
    },
  });
  try {
    const result = await fixture.service.importMinute(fixture.input);
    assert.deepEqual(result, { publicationId: 'pub-history', disposition: 'accepted' });
    assert.deepEqual(parsed, [fixture.descriptor.artifactId]);
    assert.deepEqual(inspected, [
      { locator: { artifactId: fixture.descriptor.artifactId, kind: 'minute' }, aborted: false },
    ]);
    assert.deepEqual(normalized, [fixture.descriptor]);
    assert.deepEqual(fixture.published, [{ instanceId: 'pi_official', input: fixture.signal }]);
  } finally {
    await fixture.app.close();
  }
});

test('historical import rejects invalid references without inspecting or publishing', async () => {
  const fixture = await serviceHarness({
    parseReference: () => {
      throw new TypeError('reference rejected');
    },
    inspectArtifact: async () => assert.fail('inspect must not run'),
  });
  try {
    await assert.rejects(
      fixture.service.importMinute({ ...fixture.input, reference: '/tmp/transcript.txt' }),
      (error) => error instanceof OfficialPluginHistoryImportError && error.code === 'INVALID_REFERENCE',
    );
    assert.deepEqual(fixture.published, []);
  } finally {
    await fixture.app.close();
  }
});

test('historical import rechecks revision and runtime authority after remote inspection', async () => {
  let fixture;
  fixture = await serviceHarness({
    inspectArtifact: async () => {
      await fixture.store.transaction((transaction) => {
        const instance = transaction.instances.get('pi_official');
        transaction.instances.put({
          ...instance,
          activationState: 'disabled',
          runtimeState: 'stopped',
          lifecycleRevision: 8,
        });
      });
      return fixture.descriptor;
    },
  });
  try {
    await assert.rejects(
      fixture.service.importMinute(fixture.input),
      (error) => error instanceof OfficialPluginHistoryImportError && error.code === 'STALE_REVISION',
    );
    assert.deepEqual(fixture.published, []);
  } finally {
    await fixture.app.close();
  }
});

test('historical import maps missing Minute truth without leaking lark-cli details', async () => {
  const fixture = await serviceHarness({
    inspectArtifact: async () => {
      throw Object.assign(new Error('opaque lark-cli detail'), { code: 'NOT_FOUND' });
    },
  });
  try {
    await assert.rejects(
      fixture.service.importMinute(fixture.input),
      (error) => error instanceof OfficialPluginHistoryImportError && error.code === 'SOURCE_NOT_FOUND',
    );
    assert.deepEqual(fixture.published, []);
  } finally {
    await fixture.app.close();
  }
});

test('historical import reports a runtime race when the active Broker session disappears', async () => {
  const fixture = await serviceHarness({
    broker: {
      publishOwnerImportedSignal: async () => {
        throw Object.assign(new Error('session closed'), { code: 'SESSION_NOT_FOUND' });
      },
    },
  });
  try {
    await assert.rejects(
      fixture.service.importMinute(fixture.input),
      (error) => error instanceof OfficialPluginHistoryImportError && error.code === 'INSTANCE_NOT_READY',
    );
    assert.deepEqual(fixture.published, []);
  } finally {
    await fixture.app.close();
  }
});
