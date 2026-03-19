import { describe, expect, it } from 'vitest';
import { parsePreviewUrl } from '../workspace/preview-url-utils';

describe('parsePreviewUrl', () => {
  it('parses simple localhost:PORT', () => {
    const result = parsePreviewUrl('localhost:5173');
    expect(result.valid).toBe(true);
    expect(result.port).toBe(5173);
    expect(result.path).toBe('/');
  });

  it('parses localhost:PORT/path', () => {
    const result = parsePreviewUrl('localhost:3000/dashboard');
    expect(result.valid).toBe(true);
    expect(result.port).toBe(3000);
    expect(result.path).toBe('/dashboard');
  });

  it('parses http://localhost:PORT/path', () => {
    const result = parsePreviewUrl('http://localhost:8080/app/test');
    expect(result.valid).toBe(true);
    expect(result.port).toBe(8080);
    expect(result.path).toBe('/app/test');
  });

  it('parses 127.0.0.1:PORT', () => {
    const result = parsePreviewUrl('127.0.0.1:4200');
    expect(result.valid).toBe(true);
    expect(result.port).toBe(4200);
  });

  it('rejects non-localhost URL', () => {
    const result = parsePreviewUrl('example.com:3000');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/localhost/i);
  });

  it('rejects empty input', () => {
    const result = parsePreviewUrl('');
    expect(result.valid).toBe(false);
  });

  // P1: Detect Cat Café Hub URL patterns
  it('warns when path contains /thread/ (Hub page URL)', () => {
    const result = parsePreviewUrl('localhost:3203/thread/thread_mmrp2gfn62d90yap');
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/Cat Café Hub/i);
  });

  it('warns when path starts with /api/ (Hub API URL)', () => {
    const result = parsePreviewUrl('localhost:3004/api/threads');
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/Cat Café/i);
  });

  it('warns when path starts with /api/preview (Hub preview endpoint)', () => {
    const result = parsePreviewUrl('http://localhost:3004/api/preview/status');
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/Cat Café/i);
  });

  it('does NOT warn for normal dev server paths', () => {
    const result = parsePreviewUrl('localhost:5173/dashboard');
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('does NOT warn for root path', () => {
    const result = parsePreviewUrl('localhost:3000');
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
