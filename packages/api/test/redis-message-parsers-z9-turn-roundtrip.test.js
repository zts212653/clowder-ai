/**
 * F194 Phase Z9 hotfix — `safeParseExtra` MUST preserve `extra.stream.turnInvocationId`.
 *
 * Bug: `safeParseExtra` at redis-message-parsers.ts:94-97 rebuilds
 * `result.stream = { invocationId: parsed.stream.invocationId }`, silently
 * dropping any other fields including `turnInvocationId`. Z9 backend stamping
 * wrote turn correctly, but Redis read path stripped it → frontend
 * `getBubbleInvocationId` falls back to parent → multi-turn same-cat under
 * shared parent collapses to one bubble (R13/R14 alpha re-test confirmed
 * 2026-05-11 16:08~16:11 PST chengyu game by 47 + codex).
 *
 * Fix: parser must preserve `turnInvocationId` field through the round-trip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F194 Phase Z9 hotfix — safeParseExtra preserves turnInvocationId', () => {
  it('round-trip: serialize { invocationId, turnInvocationId } → safeParseExtra preserves both', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );

    const input = {
      stream: {
        invocationId: 'parent-z9-roundtrip',
        turnInvocationId: 'turn-codex-z9-roundtrip',
      },
    };

    const serialized = serializeExtra(input);
    const parsed = safeParseExtra(serialized);

    assert.ok(parsed?.stream, 'parsed extra.stream present');
    assert.equal(parsed.stream.invocationId, 'parent-z9-roundtrip', 'invocationId preserved');
    assert.equal(
      parsed.stream.turnInvocationId,
      'turn-codex-z9-roundtrip',
      'turnInvocationId MUST be preserved by parser (bug pre-fix: silently stripped)',
    );
  });

  it('backward compat: legacy serialized stream { invocationId } only → parses without turn', async () => {
    const { safeParseExtra } = await import('../dist/domains/cats/services/stores/redis/redis-message-parsers.js');

    const legacyRaw = JSON.stringify({ stream: { invocationId: 'legacy-no-turn' } });
    const parsed = safeParseExtra(legacyRaw);

    assert.ok(parsed?.stream);
    assert.equal(parsed.stream.invocationId, 'legacy-no-turn');
    assert.equal(parsed.stream.turnInvocationId, undefined, 'legacy records remain unaffected (no turn)');
  });

  it('round-trip with same parent + turn (first-in-chain): both fields preserved', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );

    // First-in-chain case: own === parent (per Z9 backend stamp logic).
    const input = {
      stream: {
        invocationId: 'first-in-chain-id',
        turnInvocationId: 'first-in-chain-id',
      },
    };

    const serialized = serializeExtra(input);
    const parsed = safeParseExtra(serialized);
    assert.equal(parsed?.stream?.invocationId, 'first-in-chain-id');
    assert.equal(parsed?.stream?.turnInvocationId, 'first-in-chain-id');
  });
});
