/**
 * F174 D2b-3 — cloud Codex P1 #1403 round 9 (砚砚 P2): regression for the
 * top-level Hub tab resync on repeated deep-link.
 *
 * The full CatCafeHub render covers many stores + tab components, too heavy
 * to mock just for this assertion. Instead we extract `computeHubSyncKey`
 * as a pure function so we can directly verify the nonce participates: a
 * second openHub('observability', 'callback-auth') after the user navigated
 * away to another top-level tab MUST bump the syncKey, forcing the
 * render-time setTab() branch to re-fire.
 *
 * Removing `subTabNonce` from the formula must make this test FAIL.
 */

import { describe, expect, it } from 'vitest';
import { computeHubSyncKey } from '../CatCafeHub';

describe('computeHubSyncKey (F174 D2b-3 cloud P1 #1403 round 9)', () => {
  it('returns "closed" when hub is closed regardless of other args', () => {
    expect(computeHubSyncKey(false, 'observability', 1)).toBe('closed');
    expect(computeHubSyncKey(false, undefined, undefined)).toBe('closed');
  });

  it('encodes open + tab + nonce when hub is open', () => {
    expect(computeHubSyncKey(true, 'observability', 1)).toBe('open:observability:1');
  });

  it('handles missing tab and nonce gracefully (open hub without deep-link)', () => {
    expect(computeHubSyncKey(true, undefined, undefined)).toBe('open::');
  });

  it('Critical (砚砚 P2): same tab + new nonce produces a DIFFERENT syncKey', () => {
    // This is the assertion that catches the cloud P1: if subTabNonce is dropped
    // from the formula, both calls below would return the same string and
    // CatCafeHub.setTab() would never re-fire on a repeated deep-link.
    const k1 = computeHubSyncKey(true, 'observability', 1);
    const k2 = computeHubSyncKey(true, 'observability', 2);
    expect(k1).not.toBe(k2);
  });

  it('different tab values also change syncKey (regression for prior P1)', () => {
    expect(computeHubSyncKey(true, 'observability', 1)).not.toBe(computeHubSyncKey(true, 'cats', 1));
  });
});
