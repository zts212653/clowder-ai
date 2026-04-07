// F102 Batch 3 — EvidenceSearch pure function tests
import { describe, expect, it } from 'vitest';
import { buildSearchUrl, parseInitialQuery } from '../EvidenceSearch';

describe('buildSearchUrl', () => {
  it('includes dimension param when set', () => {
    const url = buildSearchUrl({ q: 'test', dimension: 'project' });
    expect(url).toContain('dimension=project');
  });

  it('omits dimension when undefined', () => {
    const url = buildSearchUrl({ q: 'test' });
    expect(url).not.toContain('dimension');
  });

  it('includes dimension=global', () => {
    const url = buildSearchUrl({ q: 'test', dimension: 'global' });
    expect(url).toContain('dimension=global');
  });
});

describe('parseInitialQuery', () => {
  it('extracts q param from URL search string', () => {
    expect(parseInitialQuery('?q=hello+world')).toBe('hello world');
  });

  it('returns empty string when no q param', () => {
    expect(parseInitialQuery('?mode=hybrid')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(parseInitialQuery('')).toBe('');
  });
});
