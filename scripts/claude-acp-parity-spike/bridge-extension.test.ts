import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { inputIdentity, proofHooks, proofInput } from './bridge-extension.ts';

test('caller input identity survives the ACP conversion', () => {
  const id = randomUUID();
  assert.equal(inputIdentity({ _meta: { clowderParity: { inputId: id } } }), id);
  assert.throws(() => inputIdentity({ _meta: { clowderParity: { inputId: 'bad' } } }));
});
test('synchronous hook stays pending until the Host response and returns additionalContext', async () => {
  let release: (value: unknown) => void = () => {};
  const notifications: unknown[] = [];
  const hooks = proofHooks(
    {
      extRequest: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      extNotification: async (_method, params) => {
        notifications.push(params);
      },
    },
    'session',
    { clowderParity: { runKey: 'run' } },
  );
  let completed = false;
  const pending = hooks
    .SessionStart![0].hooks[0](
      { hook_event_name: 'SessionStart', source: 'compact', session_id: 'native' } as never,
      undefined,
      {} as never,
    )
    .then((value) => {
      completed = true;
      return value;
    });
  await Promise.resolve();
  assert.equal(completed, false);
  release({ additionalContext: 'ONLY-FROM-HOST' });
  assert.deepEqual(await pending, {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ONLY-FROM-HOST' },
  });
  assert.equal(notifications.length, 0);
});
test('hook failure is reported and preserves current nonblocking failure behavior', async () => {
  const notices: unknown[] = [];
  const hooks = proofHooks(
    {
      extRequest: async () => {
        throw new Error('offline');
      },
      extNotification: async (_method, params) => {
        notices.push(params);
      },
    },
    'failure',
    { clowderParity: { runKey: 'run' } },
  );
  const result = await hooks.PreCompact![0].hooks[0](
    { hook_event_name: 'PreCompact', session_id: 'native' } as never,
    undefined,
    {} as never,
  );
  assert.deepEqual(result, {});
  assert.equal(notices.length, 1);
});
for (const mode of ['append', 'steer'])
  test(`${mode} uses one existing query and preserves host UUID`, async () => {
    const calls: string[] = [];
    const inputId = randomUUID();
    const peer = { extNotification: async () => {} };
    proofHooks(peer, mode, { clowderParity: { runKey: 'run' } });
    const agent = {
      sessions: {
        [mode]: {
          query: {
            interrupt: async () => {
              calls.push('interrupt');
            },
          },
          turnQueue: [{ settled: false }],
          sentUserUuids: new Set<string>(),
        },
      },
      startTurn: async (params: { _meta?: unknown }) => {
        assert.equal(inputIdentity(params), inputId);
        calls.push('push');
      },
    };
    const result = await proofInput(agent, peer, {
      sessionId: mode,
      runKey: 'run',
      inputId,
      mode,
      prompt: [{ type: 'text', text: 'fixture' }],
    });
    assert.deepEqual(calls, mode === 'append' ? ['push'] : ['interrupt', 'push']);
    assert.equal(result.inputId, inputId);
    await assert.rejects(
      proofInput(agent, peer, { sessionId: mode, runKey: 'wrong', inputId, mode, prompt: [] }),
      /Stale/,
    );
  });
