import assert from 'node:assert/strict';
import test from 'node:test';

import { createCollectiveAgentVerifier } from '../dist/domains/plugin/builtin-runtime/collective-agent-verifier.js';

const runningExecution = {
  invocationId: 'turn_real_agent_1',
  parentInvocationId: 'parent_real_agent_1',
  threadId: 'thread_collective_agent_1',
  userId: 'owner_1',
  catId: 'codex-sol',
  executionKind: 'ordinary',
  startedAt: 1_787_977_000_000,
  status: 'running',
};

test('accepts only a known Cat bound to the exact running TurnExecution session', async () => {
  const verify = createCollectiveAgentVerifier({
    resolveCatDisplayName: (catId) => (catId === 'codex-sol' ? 'Sol' : undefined),
    readTurnExecution: async (invocationId) =>
      invocationId === runningExecution.invocationId ? runningExecution : null,
  });

  await assert.doesNotReject(async () => {
    assert.equal(
      await verify({
        agentId: 'codex-sol',
        catId: 'codex-sol',
        displayName: 'Sol',
        sessionRef: runningExecution.invocationId,
      }),
      true,
    );
  });
  assert.equal(
    await verify({
      agentId: 'human-owner',
      catId: 'codex-sol',
      displayName: 'Impostor',
      sessionRef: runningExecution.invocationId,
    }),
    false,
  );
  assert.equal(
    await verify({
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: 'Forged display name',
      sessionRef: runningExecution.invocationId,
    }),
    false,
  );
  assert.equal(
    await verify({
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: 'Sol',
      sessionRef: 'turn_unknown',
    }),
    false,
  );
});

test('rejects a stale or differently-owned TurnExecution session', async () => {
  const terminalExecution = { ...runningExecution, status: 'succeeded', endedAt: runningExecution.startedAt + 1 };
  const verifyTerminal = createCollectiveAgentVerifier({
    resolveCatDisplayName: () => 'Sol',
    readTurnExecution: async () => terminalExecution,
  });
  assert.equal(
    await verifyTerminal({
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: 'Sol',
      sessionRef: terminalExecution.invocationId,
    }),
    false,
  );

  const verifyOtherCat = createCollectiveAgentVerifier({
    resolveCatDisplayName: () => 'Sol',
    readTurnExecution: async () => ({ ...runningExecution, catId: 'opus' }),
  });
  assert.equal(
    await verifyOtherCat({
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: 'Sol',
      sessionRef: runningExecution.invocationId,
    }),
    false,
  );
});
