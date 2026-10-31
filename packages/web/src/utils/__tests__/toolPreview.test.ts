import { describe, expect, it } from 'vitest';
import { extractRecallMetaDetail, toolResultDetail } from '@/utils/toolPreview';

describe('toolResultDetail', () => {
  it('keeps short output unchanged', () => {
    const raw = 'command: pwd\nstatus: completed\nexit_code: 0';
    expect(toolResultDetail(raw)).toBe(raw);
  });

  it('preserves every line of verbose output for the expandable tool detail', () => {
    const raw = [
      'command: /bin/zsh -lc ~/.codex/superpowers/.codex/superpowers-codex bootstrap',
      'status: completed',
      'exit_code: 0',
      '# Superpowers Bootstrap for Codex',
      '# ================================',
      '## Bootstrap Instructions:',
      '<EXTREMELY_IMPORTANT>',
    ].join('\n');

    const detail = toolResultDetail(raw);
    expect(detail).toBe(raw);
    expect(detail).toContain('<EXTREMELY_IMPORTANT>');
  });

  it('preserves the tail of long single-line output', () => {
    const raw = `output: ${'x'.repeat(800)} TOOL_RESULT_TAIL_SENTINEL`;
    const detail = toolResultDetail(raw);

    expect(detail).toBe(raw);
    expect(detail).toContain('TOOL_RESULT_TAIL_SENTINEL');
  });

  it('extracts trailing recall-meta before compacting visible detail', () => {
    const meta =
      '<recall-meta>{"resultStatus":"overflow","resultCount":12,"artifactRef":{"path":"/tmp/search.txt"}}</recall-meta>';
    const raw = [
      'Evidence search request failed: Error: result exceeds maximum allowed tokens.',
      'Full result saved to /tmp/search.txt',
      'preview line 1',
      'preview line 2',
      'preview line 3',
      meta,
    ].join('\n');

    const detail = toolResultDetail(raw);
    expect(detail).not.toContain('<recall-meta>');
    expect(extractRecallMetaDetail(raw)).toBe(meta);
  });

  it('strips recall-meta from short visible detail while preserving extraction', () => {
    const meta = '<recall-meta>{"resultStatus":"error","errorMessage":"graph failed"}</recall-meta>';
    const raw = ['Graph resolve failed: graph failed', meta].join('\n');

    const detail = toolResultDetail(raw);

    expect(detail).toBe('Graph resolve failed: graph failed');
    expect(detail).not.toContain('<recall-meta>');
    expect(extractRecallMetaDetail(raw)).toBe(meta);
  });

  it('extracts and strips only the appended recall-meta when earlier output contains an unclosed marker', () => {
    const meta = '<recall-meta>{"resultStatus":"counted","resultCount":3}</recall-meta>';
    const raw = [
      'Evidence search results: Found 3 result(s) for "recall-meta":',
      '1. mailbox doc',
      '   snippet: reviewer mentioned a literal <recall-meta> marker in prose',
      meta,
    ].join('\n');

    const detail = toolResultDetail(raw);

    expect(extractRecallMetaDetail(raw)).toBe(meta);
    expect(detail).toContain('snippet: reviewer mentioned a literal <recall-meta> marker in prose');
    expect(detail).not.toContain('{"resultStatus"');
  });
});
