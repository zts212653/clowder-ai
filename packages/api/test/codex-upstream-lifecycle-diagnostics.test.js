import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { CodexErrorEvidence } from '../dist/domains/cats/services/agents/providers/codex-error-evidence.js';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

const REQUEST_ID = '7ab62694-a1b3-4ef6-977e-7edb76b44640';
const HIGH_DEMAND = 'We’re currently experiencing high demand, which may cause temporary errors.';
const BARE_STREAM_ERROR = 'stream disconnected before completion';
const debugRef = { command: 'codex app-server', signal: null };

function retry(turnId, details = HIGH_DEMAND) {
  return {
    method: 'error',
    params: {
      threadId: 'native',
      turnId,
      willRetry: true,
      error: { message: 'Reconnecting... 1/5', additionalDetails: details },
    },
  };
}
function fail(turnId) {
  return {
    method: 'turn/completed',
    params: {
      threadId: 'native',
      turn: { id: turnId, status: 'failed', error: { message: BARE_STREAM_ERROR, additionalDetails: null } },
    },
  };
}
async function collectFailure(f, { live, onEvent } = {}) {
  const evidence = new CodexErrorEvidence();
  try {
    for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'synthetic diagnostic probe' },
      ...(live ? { live } : {}),
    })) {
      evidence.observe(event);
      await onEvent?.(event);
    }
    assert.fail('expected native failure');
  } catch (error) {
    assert.match(error.message, /stream disconnected|stream ended before turn completion/);
    return evidence.diagnostics(error.message, debugRef);
  }
}

for (const path of ['native_start_notification', 'accepted_host_input']) {
  test(`second Live root turn retains its cause and request ID via ${path}`, { timeout: 3000 }, async () => {
    const f = wireFixture();
    const originalWrite = f.wire.write;
    let starts = 0,
      port;
    if (path === 'accepted_host_input')
      f.wire.write = async (message) => {
        if (message.method !== 'turn/start' || starts++ === 0) return originalWrite(message);
        f.writes.push(message);
        f.push({ id: message.id, result: { turn: { id: 'second' } } });
        // Accepted RPC first, then errors immediately: no turn/started notification to rescue the binding.
        f.push(retry('second', `${HIGH_DEMAND} Please include the request ID ${REQUEST_ID} in your message.`));
        f.push(retry('foreign-turn', 'An error occurred while processing your request.'));
        f.push(fail('second'));
      };
    const diag = await collectFailure(f, {
      live: {
        finished: new Promise(() => {}),
        observe: async () => {},
        ready: async (_thread, readyPort) => {
          port = readyPort;
          if (path === 'native_start_notification') {
            f.push({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'second' } } });
            f.push(retry('second', `${HIGH_DEMAND} Please include the request ID ${REQUEST_ID} in your message.`));
            f.push(retry('foreign-turn', 'An error occurred while processing your request.'));
            f.push(fail('second'));
          }
        },
      },
      onEvent: (event) => {
        if (
          path === 'accepted_host_input' &&
          event.type === 'app_server.live_turn_completed' &&
          event.turnId === 'first'
        )
          void port.submitText('next owner input', 'fixture-message').catch(() => {});
      },
    });
    assert.equal(diag.reasonCode, 'server_overloaded');
    assert.equal(diag.debugRef.upstreamRequestId, REQUEST_ID);
    assert.doesNotMatch(diag.safeExcerpt, /processing your request/);
  });
}

for (const withCause of [true, false]) {
  test(
    `carrier EOF preserves accurate ${withCause ? 'upstream' : 'uncertain'} diagnosis`,
    { timeout: 3000 },
    async () => {
      const f = wireFixture({ holdFirstTurn: true });
      let closed = false;
      const diag = await collectFailure(f, {
        onEvent: async (event) => {
          if (!closed && event.type === 'app_server.lifecycle' && event.lifecycle.stage === 'turn_accepted') {
            closed = true;
            if (withCause)
              f.push(retry('first', `${HIGH_DEMAND} Please include the request ID ${REQUEST_ID} in your message.`));
            await f.wire.close();
          }
        },
      });
      assert.equal(diag.reasonCode, withCause ? 'server_overloaded' : 'stream_disconnected');
      assert.equal(diag.debugRef.upstreamRequestId, withCause ? REQUEST_ID : undefined);
      assert.doesNotMatch(diag.publicHint, /VPN|代理/);
    },
  );
}
