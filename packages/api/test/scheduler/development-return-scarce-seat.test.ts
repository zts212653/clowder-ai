import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevelopmentReturnFixture } from '../helpers/development-return-fixture.js';

test('registered terminal development_return still wakes a scarce original owner', async (t) => {
  const fixture = await createDevelopmentReturnFixture(t, { ownerCatId: 'fable-5' });
  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
  const report = fixture.report();
  fixture.messages.updateExtra(report.id, {
    coordination: { id: 'coord-f293-scarce-return', phase: 'terminal', hop: 0 },
    crossPost: { sourceThreadId: fixture.child.id, sourceInvocationId: 'child-invocation', effectClass: 'fyi' },
  });
  await fixture.service.report({ ...fixture.actor, threadId: fixture.child.id }, registration.registrationId, {
    sourceMessageId: report.id,
    outcome: 'completed',
    evidenceRefs: ['artifact:published'],
  });
  assert.equal(fixture.wakes.length, 1);
  assert.equal(fixture.wakes[0][1], 'fable-5');
  const wake = fixture.messages.getById(fixture.wakes[0][4]);
  assert.equal(wake?.from.kind, 'external');
  assert.equal(wake?.source?.connector, 'development-return');
  assert.equal(wake?.queueCustody, undefined);
  assert.equal(fixture.service.read(registration.registrationId)?.status, 'delivered');
});
