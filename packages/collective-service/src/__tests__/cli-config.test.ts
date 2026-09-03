import { describe, expect, it } from 'vitest';

import { resolveCollectivePublicUrl } from '../cli-config.js';

describe('Collective Service public URL', () => {
  it('allows loopback HTTP for local development', () => {
    expect(resolveCollectivePublicUrl(undefined, '127.0.0.1', 5201)).toBe('http://127.0.0.1:5201/');
    expect(resolveCollectivePublicUrl('http://localhost:6201/path?query=1#fragment', '127.0.0.1', 5201)).toBe(
      'http://localhost:6201/',
    );
    expect(resolveCollectivePublicUrl('http://[::1]:6201/', '127.0.0.1', 5201)).toBe('http://[::1]:6201/');
  });

  it('requires HTTPS for non-loopback public identity callbacks', () => {
    expect(() => resolveCollectivePublicUrl('http://collective.example.com', '127.0.0.1', 5201)).toThrow(
      'COLLECTIVE_SERVICE_PUBLIC_URL must use HTTPS unless it targets loopback',
    );
    expect(resolveCollectivePublicUrl('https://collective.example.com/oauth/path', '127.0.0.1', 5201)).toBe(
      'https://collective.example.com/',
    );
  });

  it('rejects embedded credentials and non-HTTP schemes', () => {
    expect(() => resolveCollectivePublicUrl('https://user:secret@example.com', '127.0.0.1', 5201)).toThrow(
      'COLLECTIVE_SERVICE_PUBLIC_URL must be an HTTP(S) URL without embedded credentials',
    );
    expect(() => resolveCollectivePublicUrl('file:///tmp/collective', '127.0.0.1', 5201)).toThrow(
      'COLLECTIVE_SERVICE_PUBLIC_URL must be an HTTP(S) URL without embedded credentials',
    );
  });
});
