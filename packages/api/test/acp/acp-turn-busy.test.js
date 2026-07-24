/**
 * #1211 provider-busy regression tests.
 *
 * When Kimi (or another ACP provider) rejects a new prompt because an earlier
 * turn is still active, AcpAgentService must:
 *  - cancel + seal the unsafe session,
 *  - retire the carrier so it is not reused for single-flight sessions,
 *  - NOT attempt an internal fresh-session retry (that retry is owned by
 *    invoke-single-cat so the unsafe carrier is released first),
 *  - surface a provider_busy error that invoke-single-cat can recognize.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { AcpProviderBusyError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

const TEST_POOL_KEY = { projectPath: '/tmp', providerProfile: 'test' };

function makeClient({ firstEvents = [], firstError = null } = {}) {
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
      for (const chunk of firstEvents) {
        yield {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
        };
      }
      if (firstError) throw firstError;
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
  it('zero-event busy cancels/seals session and surfaces provider_busy error', async () => {
    const sessionId = 'sess-busy';
    const client = makeClient({ firstError: busyError(sessionId) });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello again', { sessionId })) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 1, 'must not internally retry with a fresh session');
    assert.equal(inits[0].sessionId, sessionId);

    const err = messages.find((m) => m.type === 'error');
    assert.ok(err, 'busy must surface an error event');
    assert.equal(err.errorCode, 'prompt_failure');
    assert.ok(err.error.includes('provider_busy:'), `expected provider_busy marker, got: ${err.error}`);
    assert.ok(err.error.includes('Cannot launch a new turn'), `unexpected error: ${err.error}`);
    assert.equal(messages.at(-1).type, 'done');

    // Unsafe session must be cancelled + sealed, and the carrier retired.
    assert.ok(client.cancelledSessions.includes(sessionId), 'busy session must be cancelled');
    assert.ok(pool.remembered.includes(`sealed:${sessionId}`), 'busy session must be sealed');
    assert.ok(pool.retired.includes('unsafe'), 'unsafe carrier must be retired after lease release');

    // No internal retry means no extra session or prompt attempts.
    assert.equal(client.newSessionCalls, 0, 'must not create a fresh session internally');
    assert.equal(client.prompts.length, 1, 'must only attempt the original prompt');
  });

  it('busy after stale/previous turn output does not retry (fail closed)', async () => {
    // AC4: Kimi may drain events from the previous turn before rejecting the
    // new prompt with -32600. Those events must not be treated as a reason to
    // internally retry, because AcpAgentService cannot reliably attribute them
    // to the current turn. The output is still delivered; retry is delegated to
    // invoke-single-cat only when no substantive output has occurred.
    const sessionId = 'sess-busy-partial';
    const client = makeClient({ firstEvents: ['stale turn output'], firstError: busyError(sessionId) });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello', { sessionId })) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 1, 'no replacement session when output already produced');
    assert.equal(client.newSessionCalls, 0, 'no fresh session created internally');

    // Stale output must still be delivered to the user (we cannot safely replay
    // it, but we also must not silently drop user-visible content).
    assert.ok(
      messages.some((m) => m.type === 'text' && m.content === 'stale turn output'),
      'stale/previous turn output must still be delivered',
    );

    const err = messages.find((m) => m.type === 'error');
    assert.ok(err, 'busy after output must surface an error event');
    assert.equal(err.errorCode, 'prompt_failure');
    assert.ok(err.error.includes('provider_busy:'), `expected provider_busy marker, got: ${err.error}`);
    assert.equal(messages.at(-1).type, 'done');

    assert.ok(client.cancelledSessions.includes(sessionId), 'busy session must still be cancelled');
    assert.ok(pool.retired.includes('unsafe'), 'carrier must still be retired');
  });

  it('fresh non-resumed session busy also cancels/seals and surfaces error', async () => {
    const client = makeClient({ firstError: busyError('fresh-sess') });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello', {})) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 1, 'must not internally retry even for fresh-session busy');
    assert.equal(inits[0].sessionId, 'fresh-1');
    assert.equal(client.newSessionCalls, 1, 'only the original newSession');

    const err = messages.find((m) => m.type === 'error');
    assert.ok(err, 'busy must surface an error event');
    assert.ok(err.error.includes('provider_busy:'), `expected provider_busy marker, got: ${err.error}`);
    assert.equal(messages.at(-1).type, 'done');
  });
});
