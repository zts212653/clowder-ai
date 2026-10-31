import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCodexAppServerWithRecovery } from '../src/domains/cats/services/agents/providers/CodexAppServerRunner.js';
import { CodexAppServerCarrierReplacementRequiredError } from '../src/domains/cats/services/agents/providers/CodexAppServerThreadResolver.js';

const runInput = {
  prompt: { kind: 'frozen' as const, prompt: 'Continue' },
  thread: { kind: 'resume' as const, threadId: 'native-original' },
  requireExactResume: true,
};
const sessionOptions = { command: 'codex', args: ['app-server'], invocationId: 'f322-recovery' };

test('an imported thread retains bounded pre-turn transport retries on the same native ID', async () => {
  let factoryCalls = 0;
  const nativeIds: Array<string | undefined> = [];
  const events: unknown[] = [];
  const failure = new Error('startup transport failed');
  await assert.rejects(async () => {
    for await (const event of runCodexAppServerWithRecovery({
      runInput,
      sessionOptions,
      sessionFactory: async (options) => {
        nativeIds.push(options.sessionId);
        factoryCalls++;
        throw failure;
      },
      retryBudget: 1,
    }))
      events.push(event);
  }, failure);
  assert.equal(factoryCalls, 2);
  assert.deepEqual(nativeIds, ['native-original', 'native-original']);
  assert.deepEqual(events, [
    {
      type: 'app_server.recovery',
      reason: 'pre_turn_transport',
      attempt: 1,
      retryBudget: 1,
      threadId: 'native-original',
    },
  ]);
});

test('an imported thread refuses carrier replacement without acquiring a fresh-start carrier', async () => {
  let factoryCalls = 0;
  const failure = new CodexAppServerCarrierReplacementRequiredError('cannot resume', {
    cause: 'native_resume_rejected',
    previousNativeThreadId: 'native-original',
    detectedAt: 1,
    rejection: 'rollout_not_found',
  });
  await assert.rejects(async () => {
    for await (const _event of runCodexAppServerWithRecovery({
      runInput,
      sessionOptions,
      sessionFactory: async () => {
        factoryCalls++;
        throw failure;
      },
      retryBudget: 1,
    })) {
    }
  }, failure);
  assert.equal(factoryCalls, 1);
});
