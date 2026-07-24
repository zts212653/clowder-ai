/**
 * #1211 provider-busy regression tests.
 *
 * When Kimi (or another ACP provider) rejects a new prompt because an earlier
 * turn is still active, AcpAgentService must:
 *  - cancel + seal the unsafe session,
 *  - retire the carrier so it is not reused for single-flight sessions,
 *  - retry exactly once with a fresh session when zero real events were produced,
 *  - rebind the session chain via a second session_init,
 *  - fail directly when any real output has already been yielded.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { AcpProviderBusyError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

const TEST_POOL_KEY = { projectPath: '/tmp', providerProfile: 'test' };

function makeClient({ firstEvents = [], firstError = null, retryEvents = [], retryError = null } = {}) {
  const unquiesced = new Set();
  const client = {
    newSessionCalls: 0,
    loadSessionCalls: [],
    prompts: [],
    cancelledSessions: [],
    unquiesced,
    get isSafeForSingleFlightReuse() {
      return unquiesced.size === 0;
    },
    isSessionSafeForReuse(sessionId) {
      return !unquiesced.has(sessionId);
    },
    async newSession() {
      client.newSessionCalls++;
      return { sessionId: `fresh-${client.newSessionCalls}` };
    },
    async loadSession(sessionId) {
      client.loadSessionCalls.push(sessionId);
      return { sessionId };
    },
    async setSessionConfigOption() {},
    cancelSession(sessionId) {
      client.cancelledSessions.push(sessionId);
      unquiesced.add(sessionId);
    },
    async *promptStream(sessionId, text) {
      client.prompts.push({ sessionId, text });
      const isFirst = client.prompts.length === 1;
      const events = isFirst ? firstEvents : retryEvents;
      for (const chunk of events) {
        yield {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
        };
      }
      if (isFirst && firstError) throw firstError;
      if (!isFirst && retryError) throw retryError;
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  return client;
}

function makePool(client) {
  const remembered = [];
  const retired = [];
  return {
    remembered,
    retired,
    async acquire(poolKey, options = {}) {
      return {
        client,
        poolKey,
        canResumeRequestedSession: true,
        release() {
          if (!client.isSafeForSingleFlightReuse) {
            retired.push('unsafe');
          }
        },
      };
    },
    rememberSession(_poolKey, sessionId) {
      remembered.push(sessionId);
    },
    sealSession(_poolKey, sessionId) {
      remembered.push(`sealed:${sessionId}`);
    },
  };
}

function makeAdapter(pool) {
  return new AcpAgentService({
    catId: 'kimi',
    pool,
    poolKey: TEST_POOL_KEY,
    projectRoot: '/tmp',
    providerName: 'kimi',
    modelName: 'kimi-acp',
  });
}

function busyError(sessionId) {
  return new AcpProviderBusyError(
    sessionId,
    'ACP error -32600: Invalid request: Cannot launch a new turn while another turn (ID 6) is active',
  );
}

describe('AcpAgentService provider-busy handling (#1211)', () => {
  it('zero-event busy recovers with a fresh session and rebinds the session chain', async () => {
    const sessionId = 'sess-busy';
    const client = makeClient({ firstError: busyError(sessionId), retryEvents: ['recovery reply'] });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello again', {
      sessionId,
      resumeFallbackSystemPrompt: 'FALLBACK-IDENTITY',
    })) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 2, 'retry must announce the replacement session via a second session_init');
    assert.equal(inits[0].sessionId, sessionId);
    assert.equal(inits[1].sessionId, 'fresh-1');

    assert.ok(
      messages.some((m) => m.type === 'text' && m.content === 'recovery reply'),
      'recovery promptStream output must reach the consumer',
    );
    assert.equal(messages.at(-1).type, 'done');

    // Unsafe session must be cancelled + sealed, and the carrier retired.
    assert.ok(client.cancelledSessions.includes(sessionId), 'busy session must be cancelled');
    assert.ok(pool.remembered.includes(`sealed:${sessionId}`), 'busy session must be sealed');
    assert.ok(pool.retired.includes('unsafe'), 'unsafe carrier must be retired after lease release');

    // Fresh session must be remembered for pool affinity.
    assert.ok(pool.remembered.includes('fresh-1'), 'fresh session must be remembered on the pool');

    // Exactly one recovery attempt.
    assert.equal(client.newSessionCalls, 1, 'only one fresh session may be created for recovery');
    assert.equal(client.prompts.length, 2);
    assert.equal(client.prompts[0].sessionId, sessionId);
    assert.equal(client.prompts[1].sessionId, 'fresh-1');
    assert.ok(
      client.prompts[1].text.startsWith('FALLBACK-IDENTITY'),
      'retry prompt must re-inject the fallback system prompt',
    );
  });

  it('busy after real output does not retry and surfaces prompt_failure', async () => {
    const sessionId = 'sess-busy-partial';
    const client = makeClient({ firstEvents: ['partial'], firstError: busyError(sessionId) });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello', { sessionId })) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 1, 'no replacement session when output already produced');
    assert.equal(client.newSessionCalls, 0, 'no fresh session created');

    const err = messages.find((m) => m.type === 'error');
    assert.ok(err, 'busy after output must surface an error event');
    assert.equal(err.errorCode, 'prompt_failure');
    assert.ok(err.error.includes('Cannot launch a new turn'), `unexpected error: ${err.error}`);
    assert.equal(messages.at(-1).type, 'done');

    assert.ok(client.cancelledSessions.includes(sessionId), 'busy session must still be cancelled');
    assert.ok(pool.retired.includes('unsafe'), 'carrier must still be retired');
  });

  it('recovery is attempted exactly once even if the fresh session is also busy', async () => {
    const sessionId = 'sess-busy-twice';
    const client = makeClient({
      firstError: busyError(sessionId),
      retryEvents: [],
      retryError: busyError('fresh-1'),
    });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello', { sessionId })) {
      messages.push(msg);
    }

    assert.equal(client.newSessionCalls, 1, 'only one recovery session may be created');
    assert.equal(client.prompts.length, 2, 'only two prompt attempts may occur');

    const err = messages.find((m) => m.type === 'error');
    assert.ok(err, 'second busy must surface an error event');
    assert.equal(err.errorCode, 'prompt_failure');
    assert.ok(
      err.error.includes('provider_busy_recovery_failed'),
      `expected recovery failure label, got: ${err.error}`,
    );
    assert.equal(messages.at(-1).type, 'done');
  });

  it('fresh non-resumed session busy with zero events also recovers once', async () => {
    // No sessionId means resumeDisposition === 'fresh_without_resume'.
    const client = makeClient({ firstError: busyError('fresh-sess'), retryEvents: ['ok'] });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello', {})) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 2, 'fresh-session busy must also rebind to a replacement session');
    assert.equal(inits[0].sessionId, 'fresh-1');
    assert.equal(inits[1].sessionId, 'fresh-2');
    assert.equal(client.newSessionCalls, 2);
    assert.equal(messages.at(-1).type, 'done');
  });
});
