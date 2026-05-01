/**
 * F102 Phase J: RecallFeed / useRecallEvents logic tests (AC-J5, AC-J6)
 *
 * Tests use PRODUCTION-REALISTIC data shapes:
 * - tool_use.label = "${catId} → ${toolName}" (e.g. "opus → search_evidence")
 * - tool_result.label = "${catId} ← result" (generic, no tool name)
 * - tool_result.detail = plain text from evidence-tools.ts, truncated by compactToolResultDetail
 */

import { describe, expect, it } from 'vitest';
import { filterRecallEvents, parseTextResults } from '@/hooks/useRecallEvents';
import type { ToolEvent } from '@/stores/chat-types';

const makeToolEvent = (label: string, type: 'tool_use' | 'tool_result', detail?: string): ToolEvent => ({
  id: `evt-${Math.random().toString(36).slice(2)}`,
  type,
  label,
  detail,
  timestamp: Date.now(),
});

// Production-format tool_result detail from evidence-tools.ts + compactToolResultDetail
const REALISTIC_RESULT_DETAIL = `Found 2 result(s):

[high] F102 Memory Adapter
  anchor: f102…`;

const FULL_RESULT_DETAIL = `Found 3 result(s):

[high] F102 Memory Adapter
  anchor: f102
  type: phase
  > Memory adapter refactor spec covering indexing, search, and knowledge feed
[mid] ADR-015 Evidence Indexing
  anchor: adr-015
  type: decision
  > Decision to use sqlite + FTS5 for local evidence search
[low] Lesson: Redis keyPrefix
  anchor: lesson-redis
  type: lesson
  > ioredis keyPrefix only applies to simple commands`;

const VARIANT_RESULT_DETAIL = `mcp:cat-cafe-memory/cat_cafe_search_evidence (completed)
Found 6 result(s) for "猫猫杀" [variant=2ca79b599d26]:

[high] F102 Memory Adapter
  anchor: F102
  type: feature
  > Memory adapter refactor spec covering indexing, search, and knowledge feed`;

describe('parseTextResults', () => {
  it('parses production text format with confidence and title', () => {
    const results = parseTextResults(FULL_RESULT_DETAIL);
    expect(results).toHaveLength(3);
    expect(results[0].title).toBe('F102 Memory Adapter');
    expect(results[0].confidence).toBe('high');
    expect(results[0].sourceType).toBe('phase');
    expect(results[1].title).toBe('ADR-015 Evidence Indexing');
    expect(results[1].confidence).toBe('mid');
    expect(results[2].confidence).toBe('low');
  });

  it('parses truncated detail (compactToolResultDetail output)', () => {
    const results = parseTextResults(REALISTIC_RESULT_DETAIL);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('F102 Memory Adapter');
    expect(results[0].confidence).toBe('high');
  });

  it('extracts result count from header', () => {
    const results = parseTextResults('Found 5 result(s):\n\n[high] Foo');
    expect(results).toHaveLength(1); // only 1 parseable, but header says 5
  });

  it('returns empty for no-match text', () => {
    expect(parseTextResults('No results found for: redis')).toEqual([]);
    expect(parseTextResults('(no output)')).toEqual([]);
    expect(parseTextResults('')).toEqual([]);
  });
});

describe('filterRecallEvents', () => {
  it('extracts search_evidence with catId prefix label', () => {
    const events: ToolEvent[] = [
      makeToolEvent('opus → search_evidence', 'tool_use', '{"q":"redis pitfall","mode":"hybrid"}'),
      makeToolEvent('opus → read_file', 'tool_use', '{"file_path":"/foo"}'),
      makeToolEvent('opus ← result', 'tool_result', '(no output)'),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].query).toBe('redis pitfall');
    expect(recall[0].mode).toBe('hybrid');
  });

  it('pairs tool_use with next tool_result by position, not label', () => {
    const events: ToolEvent[] = [
      makeToolEvent('opus → search_evidence', 'tool_use', '{"q":"F102"}'),
      makeToolEvent('opus ← result', 'tool_result', FULL_RESULT_DETAIL),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].resultCount).toBe(3);
    expect(recall[0].results).toHaveLength(3);
    expect(recall[0].results![0].title).toBe('F102 Memory Adapter');
    expect(recall[0].results![0].confidence).toBe('high');
    expect(recall[0].results![0].sourceType).toBe('phase');
    expect(recall[0].results![1].title).toBe('ADR-015 Evidence Indexing');
  });

  it('extracts result count when evidence output includes a variant suffix', () => {
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"猫猫杀","mode":"hybrid"}'),
      makeToolEvent('codex ← result', 'tool_result', VARIANT_RESULT_DETAIL),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].resultCount).toBe(6);
    expect(recall[0].results).toHaveLength(1);
    expect(recall[0].results![0].title).toBe('F102 Memory Adapter');
  });

  it('pairs concurrent search_evidence uses with their later evidence results in FIFO order', () => {
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"first"}'),
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"second"}'),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        'Evidence search results: Found 1 result(s):\n\n[high] First Result',
      ),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        'Evidence search results: Found 1 result(s):\n\n[mid] Second Result',
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].query).toBe('first');
    expect(recall[0].resultCount).toBe(1);
    expect(recall[0].results![0].title).toBe('First Result');
    expect(recall[1].query).toBe('second');
    expect(recall[1].resultCount).toBe(1);
    expect(recall[1].results![0].title).toBe('Second Result');
  });

  it('dequeues a pending search when its evidence result is an error', () => {
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"first"}'),
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"second"}'),
      makeToolEvent('codex ← result', 'tool_result', 'Evidence search request failed: connection refused'),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        'Evidence search results: Found 1 result(s):\n\n[high] Second Result',
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].query).toBe('first');
    expect(recall[0].resultCount).toBe(0);
    expect(recall[0].results).toEqual([]);
    expect(recall[1].query).toBe('second');
    expect(recall[1].resultCount).toBe(1);
    expect(recall[1].results![0].title).toBe('Second Result');
  });

  it('does not assign a later search result to an earlier stale pending search', () => {
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"first"}'),
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"second"}'),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        'Evidence search results: Found 1 result(s) for "second":\n\n[high] Second Result',
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].query).toBe('first');
    expect(recall[0].resultCount).toBeUndefined();
    expect(recall[0].results).toBeUndefined();
    expect(recall[1].query).toBe('second');
    expect(recall[1].resultCount).toBe(1);
    expect(recall[1].results![0].title).toBe('Second Result');
  });

  it('matches a truncated long-query result header before the trailing colon', () => {
    const longQuery = `${'very long query '.repeat(18)}tail`;
    const truncatedHeader =
      `Evidence search results: Found 1 result(s) for ${JSON.stringify(longQuery)}`.slice(0, 220) + '…';
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"first"}'),
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', JSON.stringify({ query: longQuery })),
      makeToolEvent('codex ← result', 'tool_result', truncatedHeader),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].query).toBe('first');
    expect(recall[0].resultCount).toBeUndefined();
    expect(recall[1].query).toBe(longQuery);
    expect(recall[1].resultCount).toBe(1);
    expect(recall[1].results).toEqual([]);
  });

  it('falls back to an unknown pending search when exact query matching misses', () => {
    const longQuery = `${'very long query '.repeat(18)}tail`;
    const truncatedUseDetail = JSON.stringify({ query: longQuery }).slice(0, 200) + '…';
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"known-stale"}'),
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', truncatedUseDetail),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        `Evidence search results: Found 1 result(s) for ${JSON.stringify(longQuery)}:\n\n[high] Long Query Result`,
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].query).toBe('known-stale');
    expect(recall[0].resultCount).toBeUndefined();
    expect(recall[1].query).toBe(longQuery);
    expect(recall[1].resultCount).toBe(1);
    expect(recall[1].results![0].title).toBe('Long Query Result');
  });

  it('does not consume session search output as an evidence result', () => {
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"猫猫杀"}'),
      makeToolEvent('codex → cat_cafe_read_session_events', 'tool_use', '{"sessionId":"sess-1"}'),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        'Found 1 result(s) for "猫猫杀":\n\n[transcript] session=sess-1 score=0.92\n  eventNo: 42\n  > 猫猫杀 discussion',
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].query).toBe('猫猫杀');
    expect(recall[0].resultCount).toBeUndefined();
    expect(recall[0].results).toBeUndefined();
  });

  it('preserves FIFO for partial legacy search result batches without query tags', () => {
    const events: ToolEvent[] = [
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"first"}'),
      makeToolEvent('codex → cat_cafe_search_evidence', 'tool_use', '{"query":"second"}'),
      makeToolEvent(
        'codex ← result',
        'tool_result',
        'Found 1 result(s):\n\n[high] First Result\n  anchor: first\n  type: memory',
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].query).toBe('first');
    expect(recall[0].resultCount).toBe(1);
    expect(recall[0].results![0].title).toBe('First Result');
    expect(recall[1].query).toBe('second');
    expect(recall[1].resultCount).toBeUndefined();
    expect(recall[1].results).toBeUndefined();
  });

  it('handles truncated tool_result detail gracefully', () => {
    const events: ToolEvent[] = [
      makeToolEvent('opus → search_evidence', 'tool_use', '{"q":"F102"}'),
      makeToolEvent('opus ← result', 'tool_result', REALISTIC_RESULT_DETAIL),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].results).toHaveLength(1); // only first result visible due to truncation
    expect(recall[0].results![0].title).toBe('F102 Memory Adapter');
  });

  it('handles missing detail gracefully', () => {
    const events: ToolEvent[] = [makeToolEvent('opus → search_evidence', 'tool_use')];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].query).toBe('(unknown)');
  });

  it('ignores non-search_evidence events', () => {
    const events: ToolEvent[] = [
      makeToolEvent('opus → cat_cafe_post_message', 'tool_use', '{"text":"hi"}'),
      makeToolEvent('opus ← result', 'tool_result', '{}'),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(0);
  });

  it('handles cat_cafe_search_evidence label variant', () => {
    const events: ToolEvent[] = [makeToolEvent('opus → cat_cafe_search_evidence', 'tool_use', '{"q":"test query"}')];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].query).toBe('test query');
  });

  it('extracts query from production "query" param (not "q")', () => {
    const events: ToolEvent[] = [
      makeToolEvent('opus → search_evidence', 'tool_use', '{"query":"redis pitfall","mode":"hybrid"}'),
      makeToolEvent('opus ← result', 'tool_result', FULL_RESULT_DETAIL),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(1);
    expect(recall[0].query).toBe('redis pitfall');
    expect(recall[0].mode).toBe('hybrid');
  });

  it('does not cross-pair with wrong tool_result when interleaved', () => {
    const events: ToolEvent[] = [
      makeToolEvent('opus → search_evidence', 'tool_use', '{"q":"first"}'),
      makeToolEvent(
        'opus ← result',
        'tool_result',
        'Evidence search results: Found 1 result(s):\n\n[high] First Result',
      ),
      makeToolEvent('opus → read_file', 'tool_use', '{"file_path":"/foo"}'),
      makeToolEvent('opus ← result', 'tool_result', 'file contents...'),
      makeToolEvent('opus → search_evidence', 'tool_use', '{"q":"second"}'),
      makeToolEvent(
        'opus ← result',
        'tool_result',
        'Evidence search results: Found 1 result(s):\n\n[mid] Second Result',
      ),
    ];
    const recall = filterRecallEvents(events);
    expect(recall).toHaveLength(2);
    expect(recall[0].results![0].title).toBe('First Result');
    expect(recall[1].results![0].title).toBe('Second Result');
  });
});
