import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeHostWorkPolicyCommand } from '../../collective-client/src/host-work-policy-command.js';
import { fixture } from './f290-communication-reconsideration.fixture.js';
import { CAT, until } from './f290-communication-validation.host.js';

/** Production Client Human consumer + actual Service HTTP/disk, Connector/Host/Queue. Human login and model are fixtures. */
test('actual Client once command registers, owner adopts and original UNKNOWN wake accepts the same proposal; loss replays one receipt', async () => {
  const f = await fixture();
  try {
    const proposed = await f.propose();
    await f.approve('manual');
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const command = {
      type: 'collective:host-work-policy-command',
      bridgeId: 'bridge_fixture1',
      contextId: 'context_fixture1',
      contextRevision: 1,
      ...f.world.coordinates,
      connectionId: f.world.operator.connectionId,
      humanId: f.world.operator.humanId,
      commandId: 'command_fixture1',
      action: { kind: 'allow_request', workId: proposed.workId, workRevision: proposed.revision, permission: 'once' },
    };
    let lose = true;
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${f.world.serviceUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${f.world.operator.sessionToken}` },
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      if (path.endsWith('/register') && lose) {
        lose = false;
        throw new Error('fixture response lost AFTER real registration');
      }
      return value as T;
    };
    await assert.rejects(executeHostWorkPolicyCommand({ command, request, storage }), /response lost/);
    await f.world.restartService();
    const receipt = await executeHostWorkPolicyCommand({ command, request, storage });
    const policy = await f.world.operator.connector.readWorkPolicy(f.world.operator.connectionId);
    assert.ok(policy);
    assert.equal(policy.decisionMode, 'manual');
    assert.equal(policy.history.filter((item) => item.requestId === command.commandId).length, 1);
    const rule = policy.grants.find((grant) => grant.grantRef === receipt.grantRef);
    assert.deepEqual(rule?.sourceEventIds, [f.request.eventId]);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0, 'registration cannot create a Task');
    assert.ok(receipt.policyRevision);
    await f.world.operator.connector.adoptWorkPolicy(
      f.world.operator.connectionId,
      f.host.userId,
      receipt.policyRevision,
    );
    const wake = await f.callbacks.inject({
      method: 'POST',
      url: `/api/plugins/collective-connector/${f.world.operator.connectionId}/work/reconsider`,
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
      payload: {
        sourceEventId: f.request.eventId,
        catId: CAT,
        grantRef: receipt.grantRef,
        grantRevision: receipt.grantRevision,
        requestKind: 'guide',
      },
    });
    assert.equal(wake.statusCode, 200, wake.body);
    assert.equal((await f.host.messages.getById(wake.json().messageId))?.queueCustody?.ownerAuthProvenance, 'unknown');
    f.enable();
    await f.processor.processNext(f.host.endpoint.id, f.host.userId);
    await until(() => f.runs.length === 1, 'scripted Cat accepts the original proposed Work');
    assert.equal(f.runs[0], proposed.workId);
    assert.equal(f.work(proposed.workId).lifecycle, 'committed');
    await f.host.tick();
    assert.equal((await f.host.tasks.listByKind('work')).length, 1);
  } finally {
    await f.close();
  }
});

test('actual Client Human decline changes only the original proposed Work and creates no private Task', async () => {
  const f = await fixture();
  try {
    const proposed = await f.propose();
    const values = new Map<string, string>();
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${f.world.serviceUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${f.world.operator.sessionToken}` },
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value as T;
    };
    const receipt = await executeHostWorkPolicyCommand({
      command: {
        type: 'collective:host-work-policy-command',
        bridgeId: 'bridge_fixture2',
        contextId: 'context_fixture2',
        contextRevision: 1,
        ...f.world.coordinates,
        connectionId: f.world.operator.connectionId,
        humanId: f.world.operator.humanId,
        commandId: 'command_fixture2',
        action: { kind: 'decline_request', workId: proposed.workId, workRevision: proposed.revision },
      },
      request,
      storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) },
    });
    assert.equal(receipt.workRevision, proposed.revision + 1);
    assert.equal(f.work(proposed.workId).lifecycle, 'declined');
    await f.host.tick();
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 0);
  } finally {
    await f.close();
  }
});

test('lost registration revoked before adoption keeps old retry refused; explicit new Human decision grants g2 for the same proposal', async () => {
  const f = await fixture();
  try {
    const proposed = await f.propose();
    await f.approve('manual');
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const base = {
      type: 'collective:host-work-policy-command',
      bridgeId: 'bridge_fixture3',
      contextId: 'context_fixture3',
      contextRevision: 1,
      ...f.world.coordinates,
      connectionId: f.world.operator.connectionId,
      humanId: f.world.operator.humanId,
      action: { kind: 'allow_request', workId: proposed.workId, workRevision: proposed.revision, permission: 'once' },
    };
    let lose = true;
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${f.world.serviceUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${f.world.operator.sessionToken}` },
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      if (lose && path.endsWith('/register')) {
        lose = false;
        throw new Error('fixture lost committed response');
      }
      return result as T;
    };
    const old = { ...base, commandId: 'command_fixture3_old' };
    await assert.rejects(executeHostWorkPolicyCommand({ command: old, request, storage }), /lost/);
    const current = await f.world.operator.connector.readWorkPolicy(f.world.operator.connectionId);
    assert.ok(current);
    await f.world.store.registerCollectiveWorkPolicy(f.world.operator.sessionToken, {
      ...f.world.coordinates,
      connectionId: f.world.operator.connectionId,
      expectedRevision: current.revision,
      requestId: 'human-revoke-fixture3',
      decisionMode: 'manual',
      grants: current.grants
        .filter((grant) => grant.grantRef !== `owner-rule:${old.commandId}` && grant.status === 'active')
        .map(({ status: _status, grantRevision: _rev, ...scope }) => scope),
    });
    await assert.rejects(
      executeHostWorkPolicyCommand({ command: old, request, storage }),
      (cause: unknown) => cause instanceof Error && 'code' in cause && cause.code === 'permission_changed',
    );
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 0);
    const fresh = await executeHostWorkPolicyCommand({
      command: { ...base, commandId: 'command_fixture3_new' },
      request,
      storage,
    });
    assert.ok(fresh.policyRevision);
    await f.world.operator.connector.adoptWorkPolicy(
      f.world.operator.connectionId,
      f.host.userId,
      fresh.policyRevision,
    );
    const wake = await f.callbacks.inject({
      method: 'POST',
      url: `/api/plugins/collective-connector/${f.world.operator.connectionId}/work/reconsider`,
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
      payload: {
        sourceEventId: f.request.eventId,
        catId: CAT,
        grantRef: fresh.grantRef,
        grantRevision: fresh.grantRevision,
        requestKind: 'guide',
      },
    });
    assert.equal(wake.statusCode, 200, wake.body);
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 1);
    assert.equal(
      f.world.store.listCollectiveCollaboration(f.world.operator.sessionToken, f.world.coordinates.collectiveId).works
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
