import { describe, expect, it } from 'vitest';
import { formatRecallMeta, parseRecallMetaFromText } from '../recall-outcome.js';

describe('recall outcome sidecar', () => {
  it('escapes tag delimiters inside JSON string fields', () => {
    const sidecar = formatRecallMeta({
      resultStatus: 'counted',
      resultCount: 1,
      previewItems: [
        {
          title: 'needle',
          matchRank: 'high',
          authority: 'validated',
          updatedAt: '2026-07-12T00:00:00Z',
          snippet: 'snippet with </recall-meta> inside',
        },
      ],
    });

    expect(sidecar).not.toContain('inside</recall-meta>');
    const parsed = parseRecallMetaFromText(`prefix\n${sidecar}`);
    expect(parsed?.resultStatus).toBe('counted');
    expect(parsed?.previewItems?.[0]?.matchRank).toBe('high');
    expect(parsed?.previewItems?.[0]?.authority).toBe('validated');
    expect(parsed?.previewItems?.[0]?.updatedAt).toBe('2026-07-12T00:00:00Z');
    expect(parsed?.previewItems?.[0]?.snippet).toBe('snippet with </recall-meta> inside');
  });

  it('parses the appended sidecar when earlier output contains an unclosed tag marker', () => {
    const sidecar = formatRecallMeta({
      resultStatus: 'counted',
      resultCount: 3,
    });
    const text = [
      'Evidence search results: Found 3 result(s) for "recall-meta":',
      '1. mailbox doc',
      '   snippet: reviewer mentioned a literal <recall-meta> marker in prose',
      sidecar,
    ].join('\n');

    const parsed = parseRecallMetaFromText(text);

    expect(parsed?.resultStatus).toBe('counted');
    expect(parsed?.resultCount).toBe(3);
  });

  it('keeps coverage match type distinct and rejects it from the rank axis', () => {
    const text = [
      'coverage preview',
      '<recall-meta>{"resultStatus":"counted","resultCount":1,"previewItems":[{"title":"hit","matchType":"direct","matchRank":"direct"}]}</recall-meta>',
    ].join('\n');

    const parsed = parseRecallMetaFromText(text);

    expect(parsed?.previewItems?.[0]).toMatchObject({ title: 'hit', matchType: 'direct' });
    expect(parsed?.previewItems?.[0]?.matchRank).toBeUndefined();
  });

  it('migrates legacy preview confidence ranks to matchRank', () => {
    const text =
      '<recall-meta>{"resultStatus":"counted","resultCount":1,"previewItems":[{"title":"legacy rank","confidence":"high"}]}</recall-meta>';

    const parsed = parseRecallMetaFromText(text);

    expect(parsed?.previewItems?.[0]).toMatchObject({ title: 'legacy rank', matchRank: 'high' });
    expect(parsed?.previewItems?.[0]?.matchType).toBeUndefined();
  });

  it('migrates legacy preview confidence relations to matchType', () => {
    const text =
      '<recall-meta>{"resultStatus":"counted","resultCount":1,"previewItems":[{"title":"legacy relation","confidence":"direct"}]}</recall-meta>';

    const parsed = parseRecallMetaFromText(text);

    expect(parsed?.previewItems?.[0]).toMatchObject({ title: 'legacy relation', matchType: 'direct' });
    expect(parsed?.previewItems?.[0]?.matchRank).toBeUndefined();
  });

  it('keeps current axes authoritative while legacy confidence fills only a missing compatible axis', () => {
    const text =
      '<recall-meta>{"resultStatus":"counted","resultCount":2,"previewItems":[{"title":"rank wins","matchRank":"high","confidence":"low"},{"title":"relation fills","matchRank":"mid","confidence":"alias"}]}</recall-meta>';

    const parsed = parseRecallMetaFromText(text);

    expect(parsed?.previewItems?.[0]).toMatchObject({ title: 'rank wins', matchRank: 'high' });
    expect(parsed?.previewItems?.[0]?.matchType).toBeUndefined();
    expect(parsed?.previewItems?.[1]).toMatchObject({
      title: 'relation fills',
      matchRank: 'mid',
      matchType: 'alias',
    });
  });

  it('ignores malformed legacy preview confidence without dropping valid fields', () => {
    const text =
      '<recall-meta>{"resultStatus":"counted","resultCount":1,"previewItems":[{"title":"malformed","anchor":"F263","confidence":"certain"}]}</recall-meta>';

    const parsed = parseRecallMetaFromText(text);

    expect(parsed?.previewItems?.[0]).toEqual({ title: 'malformed', anchor: 'F263' });
  });

  it('parses the appended sidecar before a freshness notice trailer', () => {
    const sidecar = formatRecallMeta({
      resultStatus: 'overflow',
      readNextHint: 'Open the artifact for the full recall set.',
      previewItems: [
        {
          title: 'First hit',
          anchor: 'thread:123',
          snippet: 'Sidecar data should survive the notice wrapper.',
        },
      ],
    });
    const freshnessNotice = [
      '📬 提醒：你有 2 条未读消息（当前 thread）',
      '来自：landy, opus48',
      '调 get_thread_context 查看完整内容',
    ].join('\n');

    const parsed = parseRecallMetaFromText(`result preview\n${sidecar}\n\n${freshnessNotice}`);

    expect(parsed?.resultStatus).toBe('overflow');
    expect(parsed?.readNextHint).toBe('Open the artifact for the full recall set.');
    expect(parsed?.previewItems?.[0]?.title).toBe('First hit');
  });

  it('rejects arbitrary trailing text after the appended sidecar', () => {
    const sidecar = formatRecallMeta({
      resultStatus: 'counted',
      resultCount: 3,
    });

    const parsed = parseRecallMetaFromText(`result preview\n${sidecar}\n\nunrelated trailing text`);

    expect(parsed).toBeNull();
  });
});
