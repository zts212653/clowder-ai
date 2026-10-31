import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectReevalClosure } from '../../dist/infrastructure/harness-eval/reeval-closure.js';
import {
  buildApp,
  buildUnavailableApp,
  callbackHeaders,
  command,
  openedEvent,
  post,
  verdictId,
} from './eval-verdict-lifecycle-route-fixtures.js';

describe('eval verdict lifecycle writeback route', () => {
  it('rejects unauthenticated calls and any caller-authored identity field', async (t) => {
    const { app } = await buildApp(t);

    assert.equal((await post(app, command('acknowledge', 0))).statusCode, 401);
    const spoofed = await post(
      app,
      { ...command('acknowledge', 0), actor: { kind: 'cat', id: 'other-cat' } },
      callbackHeaders('owner-invocation'),
    );
    assert.equal(spoofed.statusCode, 400);
    assert.match(spoofed.json().error, /actor|identity/i);
    const callerDeadline = await post(
      app,
      command('request_reeval', 0, { dueAt: '2036-07-18T00:00:00.000Z' }),
      callbackHeaders('owner-invocation'),
    );
    assert.equal(callerDeadline.statusCode, 400);
    assert.equal(callerDeadline.json().error, 'invalid_command');
    await app.close();
  });

  it('accepts first acknowledge, reassignment, and suppression before the scheduled reconciler runs', async (t) => {
    const configuredOwner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner-user';
    const cases = [
      {
        payload: command('acknowledge', 0),
        headers: callbackHeaders('owner-invocation'),
        expectedType: 'owner_acknowledged',
      },
      {
        payload: command('reassign_owner', 0, { targetOwnerCatId: 'opus-47' }),
        headers: callbackHeaders('owner-invocation'),
        expectedType: 'owner_reassigned',
      },
      {
        payload: command('suppress', 0),
        headers: { 'x-test-session-user': configuredOwner },
        expectedType: 'cvo_suppressed',
      },
    ];

    for (const testCase of cases) {
      const { app, eventLog } = await buildApp(t);
      const response = await post(app, testCase.payload, testCase.headers);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        eventLog.events.map((event) => event.type),
        ['verdict_opened', testCase.expectedType],
      );
      await app.close();
    }
  });

  it('derives owner/current eval-override actors from auth and rejects the wrong cat', async (t) => {
    const { app, eventLog } = await buildApp(t);
    eventLog.events.push(openedEvent());

    const wrongCat = await post(app, command('acknowledge', 1), callbackHeaders('other-invocation'));
    assert.equal(wrongCat.statusCode, 403);

    const acknowledged = await post(app, command('acknowledge', 1), { 'x-agent-key-secret': 'owner-agent-key' });
    assert.equal(acknowledged.statusCode, 200, acknowledged.body);
    assert.equal(acknowledged.json().projection.lifecycleOwnerCatId, 'codex-sol');
    assert.equal(eventLog.events[1].actor.id, 'codex-sol');

    assert.equal((await post(app, command('plan_action', 2), callbackHeaders('owner-invocation'))).statusCode, 200);
    assert.equal(
      (
        await post(
          app,
          { ...command('record_fix', 3), refs: [{ kind: 'commit', availability: 'available', value: 'deadbeef' }] },
          callbackHeaders('owner-invocation'),
        )
      ).statusCode,
      200,
    );
    assert.equal((await post(app, command('request_reeval', 4), callbackHeaders('owner-invocation'))).statusCode, 200);
    assert.equal(eventLog.events.at(-1).dueAt, '2026-07-25T02:00:00.000Z');
    const passed = await post(
      app,
      command('record_reeval_result', 5, { result: 'passed' }),
      callbackHeaders('eval-invocation'),
    );
    assert.equal(passed.statusCode, 200, passed.body);
    assert.equal(passed.json().projection.status, 'resolved');
    assert.equal(passed.json().projection.reevalDueAt, undefined);
    assert.equal(passed.json().projection.escalation, undefined);
    await app.close();
  });

  it('allows the current lifecycle owner or operator to reassign while keeping suppression operator-only', async (t) => {
    const { app, eventLog } = await buildApp(t);
    eventLog.events.push(openedEvent());

    const catSuppress = await post(app, command('suppress', 1), callbackHeaders('owner-invocation'));
    assert.equal(catSuppress.statusCode, 403);

    const wrongCatReassign = await post(
      app,
      command('reassign_owner', 1, { targetOwnerCatId: 'opus-47' }),
      callbackHeaders('other-invocation'),
    );
    assert.equal(wrongCatReassign.statusCode, 403);

    const ownerReassigned = await post(
      app,
      command('reassign_owner', 1, { targetOwnerCatId: 'opus-47' }),
      callbackHeaders('owner-invocation'),
    );
    assert.equal(ownerReassigned.statusCode, 200, ownerReassigned.body);
    assert.equal(ownerReassigned.json().projection.targetOwnerCatId, 'opus-47');
    assert.deepEqual(eventLog.events[1].actor, { kind: 'cat', id: 'codex-sol' });

    const priorOwnerReassign = await post(
      app,
      command('reassign_owner', 2, { targetOwnerCatId: 'gpt52' }),
      callbackHeaders('owner-invocation'),
    );
    assert.equal(priorOwnerReassign.statusCode, 403);

    const newOwnerReassigned = await post(
      app,
      command('reassign_owner', 2, { targetOwnerCatId: 'codex-sol' }),
      callbackHeaders('new-owner-invocation'),
    );
    assert.equal(newOwnerReassigned.statusCode, 200, newOwnerReassigned.body);
    assert.equal(newOwnerReassigned.json().projection.targetOwnerCatId, 'codex-sol');

    const configuredOwner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner-user';
    const reassigned = await post(app, command('reassign_owner', 3, { targetOwnerCatId: 'opus-47' }), {
      'x-test-session-user': configuredOwner,
    });
    assert.equal(reassigned.statusCode, 200, reassigned.body);
    assert.equal(reassigned.json().projection.targetOwnerCatId, 'opus-47');

    const suppressed = await post(app, command('suppress', 4), { 'x-test-session-user': configuredOwner });
    assert.equal(suppressed.statusCode, 200, suppressed.body);
    assert.equal(suppressed.json().projection.status, 'suppressed_with_reason');

    const root = {
      verdictId,
      domainId: 'eval:capability-tips',
      targetOwnerCatId: 'codex-sol',
      assignedEvalCatId: 'gpt52',
    };
    assert.equal(projectReevalClosure(root, eventLog.events).status, 'suppressed_with_reason');
    await app.close();
  });

  it('returns 503 when canonical persistence is unavailable', async (t) => {
    const app = await buildUnavailableApp(t);

    const response = await post(app, command('acknowledge', 0), { 'x-test-session-user': 'owner-user' });
    assert.equal(response.statusCode, 503);
    await app.close();
  });
});
