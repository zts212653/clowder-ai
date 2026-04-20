/**
 * F102 Phase J: EvidenceSearch logic tests (AC-J2)
 *
 * Tests query building + result parsing for /api/evidence/search.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
  DEPTH_OPTIONS,
  parseSearchResults,
  SOURCE_TYPE_COLORS,
  SOURCE_TYPE_LABELS,
} from '@/components/memory/EvidenceSearch';

describe('buildSearchUrl', () => {
  it('builds basic query URL', () => {
    const url = buildSearchUrl({ q: 'redis pitfall' });
    expect(url).toBe('/api/evidence/search?q=redis+pitfall');
  });

  it('includes mode when specified', () => {
    const url = buildSearchUrl({ q: 'test', mode: 'hybrid' });
    expect(url).toContain('mode=hybrid');
  });

  it('includes scope when specified', () => {
    const url = buildSearchUrl({ q: 'test', scope: 'docs' });
    expect(url).toContain('scope=docs');
  });

  it('includes depth when specified', () => {
    const url = buildSearchUrl({ q: 'test', depth: 'raw' });
    expect(url).toContain('depth=raw');
  });

  it('includes limit when specified', () => {
    const url = buildSearchUrl({ q: 'test', limit: 10 });
    expect(url).toContain('limit=10');
  });

  it('omits undefined params', () => {
    const url = buildSearchUrl({ q: 'test' });
    expect(url).not.toContain('mode=');
    expect(url).not.toContain('scope=');
    expect(url).not.toContain('depth=');
  });
});

describe('DEPTH_OPTIONS', () => {
  it('includes summary and raw options', () => {
    expect(DEPTH_OPTIONS).toContainEqual({ value: 'summary', label: expect.any(String) });
    expect(DEPTH_OPTIONS).toContainEqual({ value: 'raw', label: expect.any(String) });
  });

  it('has at least 2 options', () => {
    expect(DEPTH_OPTIONS.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseSearchResults', () => {
  it('maps API response to display items', () => {
    const apiResponse = {
      results: [
        { title: 'ADR-001', anchor: 'adr-001', snippet: 'Some decision', confidence: 'mid', sourceType: 'decision' },
        { title: 'F102 Spec', anchor: 'f102', snippet: 'Memory adapter', confidence: 'high', sourceType: 'phase' },
      ],
      degraded: false,
    };
    const items = parseSearchResults(apiResponse);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('ADR-001');
    expect(items[0].sourceType).toBe('decision');
    expect(items[1].title).toBe('F102 Spec');
  });

  it('returns empty for error degradation', () => {
    const items = parseSearchResults({ results: [], degraded: true, degradeReason: 'evidence_store_error' });
    expect(items).toEqual([]);
  });

  it('preserves results for graceful degradation (raw_lexical_only)', () => {
    const response = {
      results: [{ title: 'T', anchor: 'a', snippet: 's', confidence: 'mid', sourceType: 'decision' }],
      degraded: true,
      degradeReason: 'raw_lexical_only',
      effectiveMode: 'lexical' as const,
    };
    const items = parseSearchResults(response);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('T');
  });

  it('handles empty results', () => {
    const items = parseSearchResults({ results: [], degraded: false });
    expect(items).toEqual([]);
  });
});

// ── Phase K: Contract Closure (AC-K1 + AC-K2) ──────────────────────

describe('AC-K1: depth=raw forces lexical mode', () => {
  it('buildSearchUrl overrides mode to lexical when depth=raw', () => {
    const url = buildSearchUrl({ q: 'test', depth: 'raw', mode: 'hybrid' });
    expect(url).toContain('mode=lexical');
    expect(url).not.toContain('mode=hybrid');
  });

  it('buildSearchUrl keeps mode when depth is not raw', () => {
    const url = buildSearchUrl({ q: 'test', depth: 'summary', mode: 'semantic' });
    expect(url).toContain('mode=semantic');
  });

  it('buildSearchUrl keeps mode when depth is omitted', () => {
    const url = buildSearchUrl({ q: 'test', mode: 'hybrid' });
    expect(url).toContain('mode=hybrid');
  });
});

describe('AC-K2: passage fields match backend shape', () => {
  it('preserves passage content/speaker/createdAt from backend', () => {
    const response = {
      results: [
        {
          title: 'Thread',
          anchor: 'thread-123',
          snippet: 'Discussion',
          confidence: 'mid',
          sourceType: 'discussion',
          passages: [{ passageId: 'p1', content: 'Hello world', speaker: 'opus', createdAt: '2026-04-13T00:00:00Z' }],
        },
      ],
      degraded: false,
    };
    const items = parseSearchResults(response);
    expect(items[0].passages![0]).toHaveProperty('content', 'Hello world');
    expect(items[0].passages![0]).toHaveProperty('speaker', 'opus');
    expect(items[0].passages![0]).toHaveProperty('passageId', 'p1');
  });

  it('preserves context passages', () => {
    const response = {
      results: [
        {
          title: 'Thread',
          anchor: 'thread-456',
          snippet: 'Context test',
          confidence: 'mid',
          sourceType: 'discussion',
          passages: [
            {
              passageId: 'p2',
              content: 'Main passage',
              speaker: 'sonnet',
              context: [{ passageId: 'p1', content: 'Before', speaker: 'opus', createdAt: '2026-04-13T00:00:00Z' }],
            },
          ],
        },
      ],
      degraded: false,
    };
    const items = parseSearchResults(response);
    expect(items[0].passages![0].context).toHaveLength(1);
    expect(items[0].passages![0].context![0]).toHaveProperty('content', 'Before');
  });
});

describe('SOURCE_TYPE_COLORS / LABELS (Issue 2)', () => {
  const expectedTypes = ['decision', 'phase', 'feature', 'lesson', 'research', 'knowledge', 'discussion', 'commit'];

  it('has a color for every expanded source type', () => {
    for (const type of expectedTypes) {
      expect(SOURCE_TYPE_COLORS[type]).toBeDefined();
    }
  });

  it('has a Chinese label for every expanded source type', () => {
    for (const type of expectedTypes) {
      expect(SOURCE_TYPE_LABELS[type]).toBeDefined();
    }
  });

  it('uses distinct colors for different types', () => {
    const colors = new Set(Object.values(SOURCE_TYPE_COLORS));
    expect(colors.size).toBeGreaterThanOrEqual(5);
  });
});
