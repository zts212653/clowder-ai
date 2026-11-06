import { describe, expect, it } from 'vitest';
import { findLineStartMentions, type MentionHandle } from '../a2a-mention-grammar.js';

const handles: MentionHandle[] = [
  { catId: 'opus', pattern: '@opus' },
  { catId: 'opus', pattern: '@布偶猫' },
  { catId: 'opus-45', pattern: '@opus-45' },
  { catId: 'codex', pattern: '@codex' },
];

describe('findLineStartMentions', () => {
  it('reads the F314 report inputs the way the API routes them', () => {
    expect(findLineStartMentions('ask @opus in prose', handles)).toEqual([]);
    expect(findLineStartMentions('@opus 请继续，如果需要再找 @codex', handles)).toEqual(['opus']);
    expect(findLineStartMentions('```\n@opus\n```', handles)).toEqual([]);
    expect(findLineStartMentions('@opus请继续', handles)).toEqual(['opus']);
  });

  it('reads a pure target list on one line and line-start mentions on later lines', () => {
    expect(findLineStartMentions('@opus @codex', handles)).toEqual(['opus', 'codex']);
    expect(findLineStartMentions('done\n\n@codex\r\n@opus', handles)).toEqual(['codex', 'opus']);
  });

  it('allows markdown quote and list prefixes before the handle', () => {
    expect(findLineStartMentions('> @opus\n- @codex\n1. @布偶猫', handles)).toEqual(['opus', 'codex', 'opus']);
  });

  it('prefers the longest handle and requires a token boundary after it', () => {
    expect(findLineStartMentions('@opus-45 look', handles)).toEqual(['opus-45']);
    expect(findLineStartMentions('@opusx look', handles)).toEqual([]);
  });

  it('stops a line at the first handle it does not know', () => {
    expect(findLineStartMentions('@co-creator @codex', handles)).toEqual([]);
  });

  it('repairs whitespace a model inserted inside a line-start handle', () => {
    expect(findLineStartMentions('@ codex please', handles)).toEqual(['codex']);
  });
});
