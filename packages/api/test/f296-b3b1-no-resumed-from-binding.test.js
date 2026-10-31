// F296 B3b-1: a persisted binding is not provider preflight proof.
//
// exec_json receives the prompt on stdin before `thread.started` reports the
// actual runtime id. Therefore requested === bound can only prove intent; it
// cannot produce `resumed` or `hot` before the provider consumes the prompt.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveContextContinuity } = await import(
  '../dist/domains/cats/services/agents/invocation/context-continuity.js'
);

const BASE = {
  capability: { provider: 'openai', carrier: 'exec_json', observesCompression: false },
  invocationId: 'inv-1',
  invocationOrigin: 'interactive',
  routeTopology: 'serial',
};

describe('F296 B3b-1: provider proof must precede hot projection', () => {
  test('exec_json requested === persisted binding remains unknown and cannot choose mode', () => {
    const handshake = resolveContextContinuity({
      ...BASE,
      requestedRuntimeSessionId: 'rt-1',
      // Deliberately supplied by a JavaScript caller: the resolver must not
      // treat cat-owned persisted state as provider-owned proof.
      boundRuntimeSessionId: 'rt-1',
    });
    assert.equal(handshake.disposition.state, 'unknown');
    assert.equal(handshake.disposition.reason, 'signal_unavailable');
    assert.equal('contextMode' in handshake, false, 'only ContextEpochOwner may choose cold/hot');
  });

  test('a new exec_json runtime is fresh but still cannot choose mode', () => {
    const handshake = resolveContextContinuity(BASE);
    assert.equal(handshake.disposition.state, 'fresh');
    assert.equal('contextMode' in handshake, false);
  });

  test('unsupported carriers remain unknown without manufacturing a mode', () => {
    const handshake = resolveContextContinuity({
      ...BASE,
      capability: { provider: 'openai', carrier: 'app_server', observesCompression: false },
      requestedRuntimeSessionId: 'rt-1',
      boundRuntimeSessionId: 'rt-1',
    });
    assert.equal(handshake.disposition.state, 'unknown');
    assert.equal(handshake.disposition.reason, 'carrier_unsupported');
    assert.equal('contextMode' in handshake, false);
  });
});
