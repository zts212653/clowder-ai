import { describe, expect, it } from 'vitest';
import {
  buildPreviewGatewayHostname,
  buildPreviewGatewayUrl,
  parsePreviewGatewayHostname,
} from '../preview-gateway.js';

describe('preview gateway request identity', () => {
  it('round-trips a target port through the reserved localhost hostname', () => {
    const hostname = buildPreviewGatewayHostname(5173);
    expect(hostname).toBe('preview-5173.localhost');
    expect(parsePreviewGatewayHostname(hostname)).toBe(5173);
  });

  it('rejects non-preview and out-of-range hostnames', () => {
    expect(parsePreviewGatewayHostname('localhost')).toBeNull();
    expect(parsePreviewGatewayHostname('preview-0.localhost')).toBeNull();
    expect(parsePreviewGatewayHostname('preview-65536.localhost')).toBeNull();
    expect(parsePreviewGatewayHostname('preview-5173.localhost.evil.example')).toBeNull();
  });

  it('builds a deep-link URL without consuming application query parameters', () => {
    expect(buildPreviewGatewayUrl(4111, 5173, '/dashboard?mode=wide&tag=a&tag=b')).toBe(
      'http://preview-5173.localhost:4111/dashboard?mode=wide&tag=a&tag=b',
    );
  });

  it('rejects invalid gateway and target ports', () => {
    expect(() => buildPreviewGatewayUrl(0, 5173)).toThrow(RangeError);
    expect(() => buildPreviewGatewayUrl(4111, 65536)).toThrow(RangeError);
  });
});
