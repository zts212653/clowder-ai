/**
 * #1091 zero-event resume retry — review P1 regression tests.
 *
 * Covers the fresh-session retry path in AcpAgentService:
 *  - P1-1: retry must yield a second session_init so the invocation layer
 *    rebinds the session chain to the fresh sessionId
 *  - P1-2: retry must repoint the outer sessionId so the abort handler
 *    cancels the fresh session, not the dead resumed one
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');

const TEST_POOL_KEY = { projectPath: '/tmp', providerProfile: 'test' };

/**
 * Fake ACP client: resumed sessions stream `resumedEvents`, fresh sessions
 * stream `freshEvents`. Text-only events keep the transformer path simple.
 */
function makeClient({ resumedEvents = [], freshEvents = [], onFreshPrompt, failNewSession = false } = {}) {
  const client = {
    newSessionCalls: 0,
    loadSessionCalls: [],
    prompts: [],
    cancelledSessions: [],
    recentCapacitySignal: null,
    async newSession() {
      client.newSessionCalls++;
      if (failNewSession) throw new Error('newSession boom');
      return { sessionId: `fresh-${client.newSessionCalls}` };
    },
    async loadSession(sessionId) {
      client.loadSessionCalls.push(sessionId);
      return { sessionId };
    },
    async setSessionConfigOption() {},
    cancelSession(sessionId) {
      client.cancelledSessions.push(sessionId);
    },
    async *promptStream(sessionId, text) {
      client.prompts.push({ sessionId, text });
      const isFresh = sessionId.startsWith('fresh-');
      if (isFresh) onFreshPrompt?.();
      const events = isFresh ? freshEvents : resumedEvents;
      for (const chunk of events) {
        yield {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
        };
      }
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  return client;
}

function makePool(client) {
  const remembered = [];
  return {
    remembered,
    async acquire(poolKey) {
      return { client, poolKey, release() {} };
    },
    rememberSession(_poolKey, sessionId) {
      remembered.push(sessionId);
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

describe('AcpAgentService zero-event resume retry (#1091 review P1)', () => {
  it('P1-1: retry yields a second session_init carrying the fresh sessionId', async () => {
    const client = makeClient({ resumedEvents: [], freshEvents: ['retry reply'] });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello again', {
      sessionId: 'sess-dead',
      resumeFallbackSystemPrompt: 'FALLBACK-IDENTITY',
    })) {
      messages.push(msg);
    }

    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 2, 'retry must announce the replacement session via a second session_init');
    assert.equal(inits[0].sessionId, 'sess-dead');
    assert.equal(inits[1].sessionId, 'fresh-1');
    assert.equal(inits[1].ephemeralSession, false, 'replacement init must keep resumable semantics');

    // Retry content flows after the second init, stream still terminates with done
    assert.ok(
      messages.some((m) => m.type === 'text' && m.content === 'retry reply'),
      'retry promptStream output must reach the consumer',
    );
    assert.equal(messages.at(-1).type, 'done');

    // Fresh session id must be remembered for pool affinity
    assert.ok(pool.remembered.includes('fresh-1'), 'fresh session must be remembered on the pool');

    // Fresh session has no memory — identity must be re-injected into the retry prompt
    assert.equal(client.prompts.length, 2);
    assert.equal(client.prompts[0].sessionId, 'sess-dead');
    assert.equal(client.prompts[1].sessionId, 'fresh-1');
    assert.ok(
      client.prompts[1].text.startsWith('FALLBACK-IDENTITY'),
      'retry prompt must re-inject the fallback system prompt',
    );
  });

  it('P1-2: abort during retry cancels the fresh session, not the dead resumed one', async () => {
    const controller = new AbortController();
    const client = makeClient({
      resumedEvents: [],
      freshEvents: ['late reply'],
      onFreshPrompt: () => controller.abort(),
    });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello again', {
      sessionId: 'sess-dead',
      signal: controller.signal,
    })) {
      messages.push(msg);
    }

    assert.ok(
      client.cancelledSessions.includes('fresh-1'),
      `abort must cancel the fresh session (cancelled: ${JSON.stringify(client.cancelledSessions)})`,
    );
    assert.ok(
      !client.cancelledSessions.includes('sess-dead'),
      'abort must not target the dead resumed session after the switch',
    );
    assert.equal(messages.at(-1).type, 'done');
  });

  it('retry newSession failure surfaces resume_empty_retry_failed and terminates', async () => {
    const client = makeClient({ resumedEvents: [], failNewSession: true });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello again', { sessionId: 'sess-dead' })) {
      messages.push(msg);
    }

    const err = messages.find((m) => m.type === 'error');
    assert.ok(err, 'retry failure must surface an error event');
    assert.ok(err.error.includes('resume_empty_retry_failed'), `unexpected error: ${err.error}`);
    assert.equal(messages.at(-1).type, 'done');
  });

  it('zero-event fresh (non-resumed) session does not trigger retry', async () => {
    const client = makeClient({ freshEvents: [] });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello', {})) {
      messages.push(msg);
    }

    assert.equal(client.newSessionCalls, 1, 'no retry session for a fresh zero-event stream');
    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 1);
    assert.equal(messages.at(-1).type, 'done');
  });

  it('resumed session with events does not trigger retry', async () => {
    const client = makeClient({ resumedEvents: ['normal reply'] });
    const pool = makePool(client);
    const adapter = makeAdapter(pool);

    const messages = [];
    for await (const msg of adapter.invoke('hello again', { sessionId: 'sess-live' })) {
      messages.push(msg);
    }

    assert.equal(client.newSessionCalls, 0, 'healthy resume must not create a fresh session');
    const inits = messages.filter((m) => m.type === 'session_init');
    assert.equal(inits.length, 1);
    assert.equal(inits[0].sessionId, 'sess-live');
    assert.ok(messages.some((m) => m.type === 'text' && m.content === 'normal reply'));
  });
});
