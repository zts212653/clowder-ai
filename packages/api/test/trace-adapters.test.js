/**
 * F237 Phase 2-C: Tier 2 Trace Adapter tests (N2, M1, M2)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Trace Adapters (N2, M1, M2)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/trace-adapters.js')} */
  let mod;

  it('load module', async () => {
    mod = await import('../dist/domains/prompt-hooks/trace-adapters.js');
  });

  it('observeN2 produces TraceEventObserved with content hash', () => {
    const event = mod.observeN2('conversation history delta content');
    assert.equal(event.hookId, 'N2');
    assert.equal(event.stage, 'per-turn');
    assert.equal(event.status, 'observed');
    assert.ok(event.contentHash.length > 0);
    assert.ok(event.tokenEstimate > 0);
    assert.ok(event.timestamp > 0);
  });

  it('observeN2 with null content produces empty hash', () => {
    const event = mod.observeN2(null);
    assert.equal(event.status, 'observed');
    assert.equal(event.contentHash, '');
    assert.equal(event.tokenEstimate, 0);
  });

  it('observeM1 produces TraceEventObserved for dispatch mission', () => {
    const event = mod.observeM1('## Dispatch Mission Context\nmission: F237');
    assert.equal(event.hookId, 'M1');
    assert.equal(event.stage, 'per-turn');
    assert.equal(event.status, 'observed');
    assert.ok(event.contentHash.length > 0);
    assert.ok(event.tokenEstimate > 0);
  });

  it('observeM2 produces TraceEventObserved for transcript hints', () => {
    const event = mod.observeM2('Transcript path: /tmp/session.jsonl');
    assert.equal(event.hookId, 'M2');
    assert.equal(event.stage, 'per-turn');
    assert.equal(event.status, 'observed');
    assert.ok(event.contentHash.length > 0);
  });

  it('createObservedEvent is the generic factory', () => {
    const event = mod.createObservedEvent('X1', 'session-init', 'test content');
    assert.equal(event.hookId, 'X1');
    assert.equal(event.stage, 'session-init');
    assert.equal(event.status, 'observed');
  });

  it('consistent hashing — same content = same hash', () => {
    const e1 = mod.observeN2('hello world');
    const e2 = mod.observeN2('hello world');
    assert.equal(e1.contentHash, e2.contentHash);
  });

  it('different content = different hash', () => {
    const e1 = mod.observeN2('content A');
    const e2 = mod.observeN2('content B');
    assert.notEqual(e1.contentHash, e2.contentHash);
  });
});
