import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { executeBehaviorCase } from '@clowder-ai/plugin-contract/conformance';

import { HostControlBehaviorAdapter } from './plugin-m0d-host-control-adapter.js';

const require = createRequire(import.meta.url);
const fixturePath = require.resolve('@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function behaviorCase(id) {
  const found = fixture.cases.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing contract behavior case ${id}`);
  return structuredClone(found);
}

test('a stopped runtime rejects delivery without auto-starting or writing a delivery frame', async () => {
  const contractCase = behaviorCase('on-message-delivery');
  const adapter = new HostControlBehaviorAdapter(contractCase);
  try {
    await adapter.setup(contractCase.given);
    await adapter.supervisor.stop(adapter.pluginInstanceId, 'test_stopped');

    assert.deepEqual(await adapter.execute(contractCase.when), { status: 'error', errorCode: 'PERMISSION' });
    assert.equal(adapter.rawHostErrorCode, 'DELIVERY_REJECTED');
    assert.equal(adapter.processes.specs.length, 1);
    assert.deepEqual(adapter.processes.deliveryFrames, []);
  } finally {
    await adapter.close();
  }
});

test('signed replay controls advance only owner retention and preserve shared truth', async () => {
  for (const id of ['delete-replay-events-preserves-canonical-messages', 'foreign-replay-delete-rejected']) {
    const contractCase = behaviorCase(id);
    const adapter = new HostControlBehaviorAdapter(contractCase);
    // eslint-disable-next-line no-await-in-loop
    const report = await executeBehaviorCase(contractCase, adapter);

    assert.deepEqual(report, { id, passed: true, failures: [] });
    assert.equal((await adapter.messagingOwner.events.readAfter('thread-1', 0, 10)).length, 1);
    assert.equal((await adapter.messagingOwner.messageStore.getRecent(10)).length, 1);
  }
});
