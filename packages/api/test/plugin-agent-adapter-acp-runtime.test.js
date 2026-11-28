import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentAdapterAcpRuntime } from '../dist/domains/plugin/declared/agent-adapter-native/agent-adapter-acp-runtime.js';

test(
  'an acknowledged ACP session close allows a new process to resume while the old process exits',
  { timeout: 1000 },
  async (t) => {
    const closing = Promise.withResolvers();
    const activation = new AbortController();
    t.after(() => {
      closing.resolve();
      activation.abort();
    });

    const calls = [];
    const runtime = createAgentAdapterAcpRuntime(async () => {
      const first = calls.length === 0;
      calls.push(first ? 'launch first' : 'launch replacement');
      return {
        cwd: 'workspace',
        client: {
          agentCapabilities: { sessionCapabilities: { close: true } },
          isSafeForSingleFlightReuse: !first,
          async newSession() {
            return { sessionId: 'same-native-id' };
          },
          async resumeSession(sessionId) {
            calls.push('resume ' + sessionId);
            return { sessionId };
          },
          async closeSession(sessionId) {
            calls.push('close session ' + sessionId);
          },
          close() {
            calls.push(first ? 'begin closing first process' : 'close replacement');
            return first ? closing.promise : Promise.resolve();
          },
          async *promptStream(sessionId, prompt) {
            assert.equal(first, false);
            assert.equal(sessionId, 'same-native-id');
            assert.equal(prompt, 'next prompt');
            return 'end_turn';
          },
          hasPromptFinalResponse: () => true,
        },
      };
    }, activation.signal);
    const signal = new AbortController().signal;
    const hostSessionId = 'saved-member-session';
    const startup = { moduleUrl: 'file:///fixture.mjs', config: { body: 'identity', marker: 'marker' } };
    assert.deepEqual(await runtime.open({ hostSessionId, startup }, signal), {
      ok: true,
      nativeSessionId: 'same-native-id',
    });
    const stream = await runtime.prompt({ hostSessionId, prompt: 'next prompt' }, signal);
    assert.deepEqual(await Array.fromAsync(stream), [
      { kind: 'terminal', stopReason: 'end_turn', finalResponse: true },
    ]);
    assert.deepEqual(calls, [
      'launch first',
      'close session same-native-id',
      'begin closing first process',
      'launch replacement',
      'resume same-native-id',
    ]);
  },
);
