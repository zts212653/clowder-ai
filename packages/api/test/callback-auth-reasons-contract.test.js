/**
 * F174 Phase A — Contract test: shared reason taxonomy stays in lockstep
 * with the API's MESSAGE_BY_REASON map and the MCP client's KNOWN_REASONS.
 *
 * If a new reason is added to @cat-cafe/shared without updating both ends,
 * this test fails — preventing the enum drift 砚砚 flagged in his Phase A
 * review (reminder #2).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('CallbackAuthFailureReason contract (F174 Phase A)', () => {
  test('shared enum has every reason API can emit + every reason MCP client knows', async () => {
    const { CALLBACK_AUTH_FAILURE_REASONS } = await import('../../shared/dist/types/callback-auth-reasons.js');
    const sharedReasons = new Set(CALLBACK_AUTH_FAILURE_REASONS);

    // Every shared reason must round-trip through API's makeCallbackAuthError
    // — if the message map is missing one, it'd undefined-coerce in the response body.
    const { makeCallbackAuthError } = await import('../dist/routes/callback-errors.js');
    for (const reason of sharedReasons) {
      const body = makeCallbackAuthError(reason);
      assert.equal(body.reason, reason, `API missing handling for reason: ${reason}`);
      assert.ok(body.message && typeof body.message === 'string', `API missing message for: ${reason}`);
    }

    // MCP client side: the parser uses a Set built from CALLBACK_AUTH_FAILURE_REASONS,
    // so we additionally check the helper recognises every shared reason.
    const { isCallbackAuthFailureReason } = await import('../../shared/dist/types/callback-auth-reasons.js');
    for (const reason of sharedReasons) {
      assert.equal(isCallbackAuthFailureReason(reason), true, `Shared guard rejects own reason: ${reason}`);
    }
    assert.equal(isCallbackAuthFailureReason('totally_made_up'), false);
  });

  test('expected reasons are present (regression guard for accidental deletion)', async () => {
    const { CALLBACK_AUTH_FAILURE_REASONS } = await import('../../shared/dist/types/callback-auth-reasons.js');
    const expected = ['expired', 'invalid_token', 'unknown_invocation', 'missing_creds', 'stale_invocation'];
    for (const r of expected) {
      assert.ok(CALLBACK_AUTH_FAILURE_REASONS.includes(r), `missing core reason: ${r}`);
    }
  });
});
