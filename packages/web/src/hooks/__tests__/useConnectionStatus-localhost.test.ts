// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { deriveSocketLevel, shouldForceBrowserOffline } from '../useConnectionStatus';

describe('useConnectionStatus localhost handling', () => {
  it('does not force loopback API targets offline when the browser reports offline', () => {
    expect(shouldForceBrowserOffline(false, 'http://localhost:3004')).toBe(false);
    expect(shouldForceBrowserOffline(false, 'http://127.0.0.1:3004')).toBe(false);
    expect(shouldForceBrowserOffline(false, 'http://[::1]:3004')).toBe(false);
  });

  it('still treats remote API targets as offline when the browser reports offline', () => {
    expect(shouldForceBrowserOffline(false, 'https://api.clowder-ai.com')).toBe(true);
  });

  it('does not downgrade a live loopback socket just because navigator.onLine is false', () => {
    expect(deriveSocketLevel(false, true, 'http://localhost:3004')).toBe('online');
  });

  it('marks an unknown remote socket offline when the browser reports offline', () => {
    expect(deriveSocketLevel(false, null, 'https://api.clowder-ai.com')).toBe('offline');
  });
});
