/**
 * Regression test: usePreviewBridge origin validation (Bug C from F120 Alpha)
 *
 * Console panel showed no output because postMessage origin check only
 * accepted gateway localhost origins, but in Alpha the Hub runs on port 3011
 * while gateway runs on 4111.
 */
import { describe, expect, it } from 'vitest';
import { getPreviewBridgeOrigin, isValidBridgeOrigin } from '../workspace/preview-bridge-origin';

describe('usePreviewBridge origin validation (regression)', () => {
  it('accepts gateway localhost origin', () => {
    expect(isValidBridgeOrigin('http://localhost:4111', 4111, 5173, 'http://localhost:3011')).toBe(true);
  });

  it('accepts gateway 127.0.0.1 origin', () => {
    expect(isValidBridgeOrigin('http://127.0.0.1:4111', 4111, 5173, 'http://localhost:3011')).toBe(true);
  });

  it('accepts the exact per-target preview origin', () => {
    expect(isValidBridgeOrigin('http://preview-5173.localhost:4111', 4111, 5173, 'http://localhost:3011')).toBe(true);
    expect(getPreviewBridgeOrigin(4111, 5173)).toBe('http://preview-5173.localhost:4111');
  });

  it('rejects another target preview origin', () => {
    expect(isValidBridgeOrigin('http://preview-5174.localhost:4111', 4111, 5173, 'http://localhost:3011')).toBe(false);
  });

  it('accepts Hub origin (window.location.origin) — Alpha scenario', () => {
    // This is the Bug C fix: Hub on 3011, gateway on 4111
    expect(isValidBridgeOrigin('http://localhost:3011', 4111, 5173, 'http://localhost:3011')).toBe(true);
  });

  it('rejects unknown origin', () => {
    expect(isValidBridgeOrigin('http://evil.com', 4111, 5173, 'http://localhost:3011')).toBe(false);
  });

  it('accepts any origin when gatewayPort is 0 (not yet resolved)', () => {
    expect(isValidBridgeOrigin('http://anything.com', 0, 0, 'http://localhost:3011')).toBe(true);
  });
});
