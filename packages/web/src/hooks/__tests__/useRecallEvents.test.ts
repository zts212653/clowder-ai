// F102 Batch 3 — parseTextResults + anchorToHref
import { describe, expect, it } from 'vitest';
import { anchorToHref, parseTextResults } from '../useRecallEvents';

const SAMPLE_OUTPUT = `Found 2 result(s):

[high] F102 Memory Adapter Refactor
  anchor: doc:features/F102-memory-adapter-refactor
  type: feature
  > F102: 记忆组件 Adapter 化重构 — IEvidenceStore + 本地索引

[mid] LL-045: Runtime worktree 污染
  anchor: LL-045
  type: lesson
  > 2026-03-29 runtime worktree 被多个布偶猫 session 反复弄脏
`;

describe('parseTextResults', () => {
  it('extracts title, confidence, sourceType, anchor, snippet from standard output', () => {
    const results = parseTextResults(SAMPLE_OUTPUT);
    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      title: 'F102 Memory Adapter Refactor',
      confidence: 'high',
      sourceType: 'feature',
      anchor: 'doc:features/F102-memory-adapter-refactor',
      snippet: 'F102: 记忆组件 Adapter 化重构 — IEvidenceStore + 本地索引',
    });

    expect(results[1]).toMatchObject({
      title: 'LL-045: Runtime worktree 污染',
      confidence: 'mid',
      sourceType: 'lesson',
      anchor: 'LL-045',
      snippet: '2026-03-29 runtime worktree 被多个布偶猫 session 反复弄脏',
    });
  });

  it('handles results with no anchor/snippet lines gracefully', () => {
    const text = `Found 1 result(s):

[low] Some Title
  type: discussion
`;
    const results = parseTextResults(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Some Title');
    expect(results[0]!.anchor).toBeUndefined();
    expect(results[0]!.snippet).toBeUndefined();
  });

  it('returns empty array for empty input', () => {
    expect(parseTextResults('')).toEqual([]);
  });

  it('skips [DEGRADED] banner — not a real result (PR #923)', () => {
    const text = `[DEGRADED] Evidence store error — results may be incomplete

Found 2 result(s):

[high] F102 Memory Adapter
  anchor: doc:features/F102
  type: feature
  > description

[mid] Some Lesson
  anchor: LL-001
  type: lesson
`;
    const results = parseTextResults(text);
    expect(results).toHaveLength(2);
    expect(results[0]!.confidence).toBe('high');
    expect(results[1]!.confidence).toBe('mid');
    // DEGRADED banner must not appear as a result
    expect(results.every((r) => r.confidence !== 'DEGRADED')).toBe(true);
  });
});

describe('anchorToHref', () => {
  it('maps thread anchor to /thread/{threadId}', () => {
    expect(anchorToHref('thread-thread_abc123')).toBe('/thread/thread_abc123');
  });

  it('maps doc: anchor to evidence search', () => {
    expect(anchorToHref('doc:features/F102-memory-adapter-refactor')).toBe(
      '/memory/search?q=doc%3Afeatures%2FF102-memory-adapter-refactor',
    );
  });

  it('maps LL-NNN lesson anchor to evidence search', () => {
    expect(anchorToHref('LL-045')).toBe('/memory/search?q=LL-045');
  });

  it('maps feature ID anchor to evidence search', () => {
    expect(anchorToHref('F102')).toBe('/memory/search?q=F102');
  });

  it('maps session anchor to evidence search', () => {
    expect(anchorToHref('session-sess_abc')).toBe('/memory/search?q=session-sess_abc');
  });

  it('maps ADR anchor to evidence search', () => {
    expect(anchorToHref('ADR-015')).toBe('/memory/search?q=ADR-015');
  });

  it('returns null for undefined', () => {
    expect(anchorToHref(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(anchorToHref('')).toBeNull();
  });
});
