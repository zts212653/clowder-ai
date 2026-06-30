// F102 Batch 3 — parseTextResults + anchorToHref + deduplicateRecallEvents
import { describe, expect, it } from 'vitest';
import type { RecallEvent } from '../useRecallEvents';
import {
  anchorToHref,
  deduplicateRecallEvents,
  parseTextResults,
  recallEventDisplayTitle,
  recallEventResultLabel,
} from '../useRecallEvents';

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

// F102 bugfix regression: deduplicateRecallEvents
describe('deduplicateRecallEvents', () => {
  const makeRecall = (id: string, query: string, timestamp: number, extra: Partial<RecallEvent> = {}): RecallEvent => ({
    id,
    query,
    timestamp,
    resultCount: 1,
    ...extra,
  });

  it('returns only live events when history is empty (thread switch clears stale)', () => {
    const live = [makeRecall('live-1', 'F102', 1000), makeRecall('live-2', 'F200', 2000)];
    const history: RecallEvent[] = [];

    const result = deduplicateRecallEvents(live, history);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('live-1');
    expect(result[1]!.id).toBe('live-2');
  });

  it('returns only history events when live is empty (page refresh)', () => {
    const live: RecallEvent[] = [];
    const history = [makeRecall('hist-1', 'old query', 500)];

    const result = deduplicateRecallEvents(live, history);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('hist-1');
  });

  it('deduplicates by timestamp:query — live takes precedence', () => {
    const live = [makeRecall('live-1', 'F102', 1000)];
    const history = [
      makeRecall('hist-dup', 'F102', 1000), // same timestamp+query → duplicate
      makeRecall('hist-unique', 'F200', 2000), // different → kept
    ];

    const result = deduplicateRecallEvents(live, history);
    expect(result).toHaveLength(2);
    // live-1 kept (precedence), hist-dup dropped, hist-unique kept
    expect(result.map((r) => r.id)).toEqual(['live-1', 'hist-unique']);
  });

  it('sorts merged results by timestamp ascending', () => {
    const live = [makeRecall('live-late', 'query2', 3000)];
    const history = [makeRecall('hist-early', 'query1', 1000)];

    const result = deduplicateRecallEvents(live, history);
    expect(result).toHaveLength(2);
    expect(result[0]!.timestamp).toBe(1000);
    expect(result[1]!.timestamp).toBe(3000);
  });

  it('handles both empty — returns empty array', () => {
    expect(deduplicateRecallEvents([], [])).toEqual([]);
  });
});

describe('recallEventDisplayTitle', () => {
  it('renders query-less list_recent events as readable memory navigation', () => {
    const event: RecallEvent = {
      id: 'recent-docs',
      query: '',
      toolName: 'list_recent',
      scope: 'docs',
      timestamp: 1000,
    };

    expect(recallEventDisplayTitle(event)).toBe('最近记忆 · docs');
  });

  it('keeps search_evidence queries as the primary title', () => {
    const event: RecallEvent = {
      id: 'search',
      query: 'workspace_navigate feature owner',
      toolName: 'search_evidence',
      timestamp: 1000,
    };

    expect(recallEventDisplayTitle(event)).toBe('workspace_navigate feature owner');
  });
});

describe('recallEventResultLabel', () => {
  it('shows explicit hit counts when telemetry recorded resultCount', () => {
    expect(
      recallEventResultLabel({
        id: 'search',
        query: 'F102',
        timestamp: 1000,
        resultCount: 0,
        results: [],
      }),
    ).toBe('0 条命中');
  });

  it('marks historical rows with candidates but missing resultCount as telemetry-unknown', () => {
    expect(
      recallEventResultLabel({
        id: 'unknown',
        query: 'oversized search',
        timestamp: 1000,
        results: [],
      }),
    ).toBe('命中数未记录');
  });

  it('does not label pending live tool_use events before a result arrives', () => {
    expect(
      recallEventResultLabel({
        id: 'pending',
        query: 'F200',
        timestamp: 1000,
      }),
    ).toBeUndefined();
  });
});
