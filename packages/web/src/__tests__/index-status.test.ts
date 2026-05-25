/**
 * F102 Phase J: IndexStatus logic tests (AC-J4)
 * F188 Phase A: RebuildJob parsing tests (AC-A3)
 */

import { describe, expect, it } from 'vitest';
import {
  filterEvidenceVars,
  getConfigVars,
  isEmbeddingWarmingUp,
  parseIndexStatus,
  parseRebuildJob,
} from '@/components/memory/IndexStatus';

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

describe('isEmbeddingWarmingUp (F209)', () => {
  const make = (passages: number, vectors: number, supported = true) =>
    parseIndexStatus({
      backend: 'sqlite',
      healthy: true,
      passages_count: passages,
      passage_vectors_count: vectors,
      passage_vectors_supported: supported,
    });

  it('parses passage_vectors_count', () => {
    expect(make(8608, 2368).passageVectorsCount).toBe(2368);
  });

  it('defaults passageVectorsCount to 0 when the field is absent', () => {
    expect(parseIndexStatus({ backend: 'sqlite', healthy: true }).passageVectorsCount).toBe(0);
  });

  it('parses passage_vectors_supported (defaults false when absent)', () => {
    expect(make(8608, 2368, true).passageVectorsSupported).toBe(true);
    expect(parseIndexStatus({ backend: 'sqlite', healthy: true }).passageVectorsSupported).toBe(false);
  });

  it('is warming up when vectors lag behind passages', () => {
    expect(isEmbeddingWarmingUp(make(8608, 2368))).toBe(true);
  });

  it('is done once every passage has a vector', () => {
    expect(isEmbeddingWarmingUp(make(8608, 8608))).toBe(false);
  });

  it('is not warming up when there are no passages', () => {
    expect(isEmbeddingWarmingUp(make(0, 0))).toBe(false);
  });

  it('is NOT warming up when passage vectors are unsupported (embed off / no sqlite-vec)', () => {
    // codex P2 regression: a missing vec table must NOT render "暖机中" forever and poll every 3s.
    expect(isEmbeddingWarmingUp(make(8608, 0, false))).toBe(false);
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

describe('parseRebuildJob (F188 AC-A3)', () => {
  it('parses running job', () => {
    const raw = { id: 'abc', status: 'running', phase: 'scanning', percent: 42, startedAt: 1000 };
    const job = parseRebuildJob(raw);
    expect(job.status).toBe('running');
    expect(job.phase).toBe('scanning');
    expect(job.percent).toBe(42);
  });

  it('parses done job with result', () => {
    const raw = {
      id: 'abc',
      status: 'done',
      phase: 'done',
      percent: 100,
      startedAt: 1000,
      completedAt: 2000,
      result: { docsIndexed: 50, docsSkipped: 10, durationMs: 3000 },
    };
    const job = parseRebuildJob(raw);
    expect(job.status).toBe('done');
    expect(job.result?.docsIndexed).toBe(50);
    expect(job.result?.durationMs).toBe(3000);
  });

  it('parses error job', () => {
    const raw = { id: 'abc', status: 'error', phase: '', percent: 30, startedAt: 1000, error: 'disk full' };
    const job = parseRebuildJob(raw);
    expect(job.status).toBe('error');
    expect(job.error).toBe('disk full');
  });

  it('handles missing optional fields', () => {
    const raw = { id: 'x', status: 'pending', phase: '', percent: 0, startedAt: 1000 };
    const job = parseRebuildJob(raw);
    expect(job.result).toBeUndefined();
    expect(job.error).toBeUndefined();
    expect(job.completedAt).toBeUndefined();
  });
});
