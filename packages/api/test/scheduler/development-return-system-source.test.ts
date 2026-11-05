import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevelopmentReturnContinuationFixture as continuationFixture } from '../helpers/development-return-continuation-fixture.js';

test('a canonical delivered terminal return can trigger the approved successor Task child', async (t) => {
  const f = await continuationFixture(t);

  const registration = await f.service.register(f.actor, f.currentInput, 'strict');

  assert.equal(registration.taskRef, `task:work:${f.currentTask.id}`);
  assert.equal(registration.sourceActionRef, `message:${f.currentHuman.id}`);
  assert.equal(registration.status, 'waiting');
});

for (const scenario of [
  'generic connector',
  'unknown registration',
  'return metadata drift',
  'wrong Task predecessor',
  'system trigger as human authority',
  'deadline-only return',
] as const) {
  test(`system-triggered continuation rejects ${scenario}`, async (t) => {
    const f = await continuationFixture(t, scenario === 'deadline-only return' ? 'deadline_review' : 'terminal_report');
    assert.ok(f.wake.source?.meta);
    switch (scenario) {
      case 'generic connector':
        f.wake.source = { ...f.wake.source, connector: 'test' };
        break;
      case 'unknown registration':
        f.wake.source = {
          ...f.wake.source,
          meta: { ...f.wake.source.meta, registrationId: 'development-return-unknown' },
        };
        break;
      case 'return metadata drift':
        f.wake.source = {
          ...f.wake.source,
          meta: { ...f.wake.source.meta, currentRevision: '999' },
        };
        break;
      case 'wrong Task predecessor':
        assert.ok(f.currentTask.entrustedWork);
        Object.assign(f.currentTask.entrustedWork, { predecessorTaskRef: 'task:work:another-task' });
        break;
      case 'system trigger as human authority':
        f.currentInput.sourceActionRef = `message:${f.wake.id}`;
        break;
      case 'deadline-only return':
        break;
    }

    await assert.rejects(f.service.register(f.actor, f.currentInput, 'strict'), /Original human source/);
    assert.equal(f.service.readForActor(f.actor).length, 1, 'only the terminal predecessor registration remains');
  });
}

for (const mutation of ['trigger deleted', 'trigger edited', 'human deleted', 'human edited'] as const) {
  test(`system-triggered continuation retires when its ${mutation}`, async (t) => {
    const f = await continuationFixture(t);
    const registration = await f.service.register(f.actor, f.currentInput, 'strict');
    const target = mutation.startsWith('trigger') ? f.wake : f.currentHuman;
    if (mutation.endsWith('deleted')) {
      assert.ok(f.messages.softDelete(target.id, f.actor.userId));
    } else {
      target.content = `${target.content} edited after registration`;
    }

    f.tick(20_000);
    await f.runner.triggerNow(registration.registrationId);

    assert.equal(f.service.read(registration.registrationId)?.status, 'retired');
    assert.equal(f.wakes.length, 1, 'only the predecessor wake was delivered');
  });
}

for (const mutation of ['deleted', 'edited'] as const) {
  test(`predecessor report ${mutation} before registration cannot support current provenance`, async (t) => {
    const f = await continuationFixture(t);
    const binding = f.predecessorRegistration.report;
    assert.ok(binding);
    const report = f.messages.getById(binding.sourceMessageId);
    assert.ok(report);
    if (mutation === 'deleted') assert.ok(f.messages.softDelete(report.id, f.actor.userId));
    else report.content = `${report.content} changed after predecessor delivery`;

    await assert.rejects(f.service.register(f.actor, f.currentInput, 'strict'), /source|unavailable/i);
  });

  test(`predecessor report ${mutation} after registration retires pending successor`, async (t) => {
    const f = await continuationFixture(t);
    const registration = await f.service.register(f.actor, f.currentInput, 'strict');
    const binding = f.predecessorRegistration.report;
    assert.ok(binding);
    const report = f.messages.getById(binding.sourceMessageId);
    assert.ok(report);
    if (mutation === 'deleted') assert.ok(f.messages.softDelete(report.id, f.actor.userId));
    else report.content = `${report.content} changed after successor registration`;

    f.tick(20_000);
    await f.runner.triggerNow(registration.registrationId);

    assert.equal(f.service.read(registration.registrationId)?.status, 'retired');
    assert.equal(f.wakes.length, 1, 'only the predecessor wake was delivered');
  });
}
