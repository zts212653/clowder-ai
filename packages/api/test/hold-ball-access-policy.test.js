import assert from 'node:assert/strict';
import { test } from 'node:test';

test('agent-key rescue requires canonical visibility plus owner or participant standing', async () => {
  const { resolveHoldAccess } = await import('../dist/domains/ball-custody/hold-ball-access-policy.js');
  const task = {
    id: 'hold-ball-agent-key',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: Date.now() + 60_000 },
    params: { triggerUserId: 'owner-user' },
    display: { label: 'hold', category: 'system' },
    deliveryThreadId: 'thread-shared',
    enabled: true,
    createdBy: 'hold-ball:codex-sol',
    createdAt: new Date().toISOString(),
  };
  const thread = { id: 'thread-shared', participants: ['codex-terra'] };
  const principal = {
    kind: 'agent_key',
    agentKeyId: 'agent-key-terra',
    userId: 'collaborator-user',
    catId: 'codex-terra',
    scope: 'user-bound',
  };

  const allowed = resolveHoldAccess({
    task,
    thread,
    callbackPrincipal: principal,
    configuredOwnerUserId: 'operator-user',
    principalCanAccessThread: true,
    operatorCanAccessThread: false,
  });
  assert.equal(allowed?.actor.role, 'thread_collaborator');
  assert.equal(allowed?.lifecycleVisibility, 'summary');

  assert.equal(
    resolveHoldAccess({
      task,
      thread: { ...thread, participants: [] },
      callbackPrincipal: principal,
      configuredOwnerUserId: 'operator-user',
      principalCanAccessThread: true,
      operatorCanAccessThread: false,
    }),
    null,
  );
});
