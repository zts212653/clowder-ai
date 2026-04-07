/**
 * F102 Phase J: IndexStatus logic tests (AC-J4)
 *
 * Tests parsing of /api/evidence/status response.
 */

import { describe, expect, it } from 'vitest';
import { filterEvidenceVars, getConfigVars, parseIndexStatus } from '@/components/memory/IndexStatus';

describe('parseIndexStatus', () => {
  it('parses healthy response', () => {
    const raw = {
      backend: 'sqlite',
      healthy: true,
      docs_count: 42,
      edges_count: 128,
      last_rebuild_at: '2026-03-31T10:00:00Z',
    };
    const status = parseIndexStatus(raw);
    expect(status.healthy).toBe(true);
    expect(status.docsCount).toBe(42);
    expect(status.edgesCount).toBe(128);
    expect(status.lastRebuildAt).toBe('2026-03-31T10:00:00Z');
    expect(status.backend).toBe('sqlite');
  });

  it('parses unhealthy response', () => {
    const raw = { backend: 'sqlite', healthy: false, reason: 'no_db' };
    const status = parseIndexStatus(raw);
    expect(status.healthy).toBe(false);
    expect(status.reason).toBe('no_db');
    expect(status.docsCount).toBe(0);
  });

  it('handles missing fields gracefully', () => {
    const raw = { backend: 'sqlite', healthy: true };
    const status = parseIndexStatus(raw);
    expect(status.docsCount).toBe(0);
    expect(status.edgesCount).toBe(0);
    expect(status.threadsCount).toBe(0);
    expect(status.passagesCount).toBe(0);
    expect(status.lastRebuildAt).toBeNull();
    expect(status.embeddingModel).toBeNull();
  });

  it('parses threads, passages, and embedding mode (Issue 6)', () => {
    const raw = {
      backend: 'sqlite',
      healthy: true,
      docs_count: 50,
      threads_count: 12,
      passages_count: 340,
      edges_count: 80,
      last_rebuild_at: '2026-04-01T12:00:00Z',
      embedding_model: 'text-embedding-3-small',
    };
    const status = parseIndexStatus(raw);
    expect(status.threadsCount).toBe(12);
    expect(status.passagesCount).toBe(340);
    expect(status.embeddingModel).toBe('text-embedding-3-small');
  });
});

describe('filterEvidenceVars', () => {
  const mkVar = (name: string, category: string, sensitive = false) => ({
    name,
    defaultValue: 'off',
    description: `desc for ${name}`,
    category,
    sensitive,
    currentValue: 'on',
  });

  it('returns only evidence-category non-sensitive vars', () => {
    const vars = [mkVar('EMBED_MODE', 'evidence'), mkVar('F102_API_KEY', 'evidence', true), mkVar('PORT', 'server')];
    const result = filterEvidenceVars(vars);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('EMBED_MODE');
  });

  it('returns empty for no evidence vars', () => {
    expect(filterEvidenceVars([mkVar('PORT', 'server')])).toEqual([]);
  });

  it('excludes non-toggle vars like URLs and paths', () => {
    const urlVar = { ...mkVar('EMBED_URL', 'evidence'), defaultValue: 'http://127.0.0.1:9880' };
    const pathVar = { ...mkVar('F102_GLOBAL_DB_PATH', 'evidence'), defaultValue: '~/.cat-cafe/global.sqlite' };
    const toggleVar = mkVar('F102_ABSTRACTIVE', 'evidence'); // defaultValue='off'
    const result = filterEvidenceVars([urlVar, pathVar, toggleVar]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('F102_ABSTRACTIVE');
  });
});

describe('getConfigVars', () => {
  const mkVar = (name: string, category: string, defaultValue = 'off', sensitive = false) => ({
    name,
    defaultValue,
    description: `desc for ${name}`,
    category,
    sensitive,
    currentValue: null as string | null,
  });

  it('returns non-toggle evidence vars (URLs, paths, ports)', () => {
    const vars = [
      mkVar('F102_ABSTRACTIVE', 'evidence', 'off'), // toggle → excluded
      mkVar('EMBED_URL', 'evidence', 'http://127.0.0.1:9880'),
      mkVar('EVIDENCE_DB', 'evidence', '{repoRoot}/evidence.sqlite'),
      mkVar('PORT', 'server', '3001'), // wrong category → excluded
    ];
    const result = getConfigVars(vars);
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.name)).toEqual(['EMBED_URL', 'EVIDENCE_DB']);
  });

  it('includes sensitive vars', () => {
    const vars = [mkVar('F102_API_KEY', 'evidence', '(未设置)', true)];
    const result = getConfigVars(vars);
    expect(result).toHaveLength(1);
    expect(result[0]!.sensitive).toBe(true);
  });

  it('includes tri-state vars like EMBED_MODE', () => {
    const embedMode = { ...mkVar('EMBED_MODE', 'evidence', 'off'), currentValue: 'shadow' };
    // EMBED_MODE has defaultValue='off' so filterEvidenceVars includes it, but currentValue='shadow' makes it non-binary
    // getConfigVars should NOT include it since its defaultValue is 'off' (toggle territory)
    const result = getConfigVars([embedMode]);
    expect(result).toHaveLength(0);
  });

  it('returns empty for no evidence vars', () => {
    expect(getConfigVars([mkVar('PORT', 'server', '3001')])).toEqual([]);
  });
});
