import { describe, expect, it } from 'vitest';
import { readFrontmatterPairs, readMarkdownFrontmatter } from '../markdown-frontmatter.js';

describe('readMarkdownFrontmatter', () => {
  it('reads the same mapping from LF, CRLF and BOM-prefixed headers', () => {
    const variants = [
      '---\nscope: personal\nname: Probe\n---\nbody',
      '---\r\nscope: personal\r\nname: Probe\r\n---\r\nbody',
      '﻿---\nscope: personal\nname: Probe\n---\nbody',
    ];
    for (const content of variants) {
      const header = readMarkdownFrontmatter(content);
      expect(header.status).toBe('parsed');
      if (header.status !== 'parsed') continue;
      expect(header.data).toEqual({ scope: 'personal', name: 'Probe' });
      expect(header.body).toBe('body');
    }
  });

  it('applies YAML quoting and types instead of keeping raw text', () => {
    const header = readMarkdownFrontmatter(
      '---\nscope: "personal"\nsensitivity: \'private\'\nkeywords: [a, b]\ncount: 3\n---\n',
    );
    expect(header).toMatchObject({
      status: 'parsed',
      data: { scope: 'personal', sensitivity: 'private', keywords: ['a', 'b'], count: 3 },
    });
  });

  it('separates a missing header from a header YAML rejects', () => {
    expect(readMarkdownFrontmatter('# Title\nno header')).toEqual({ status: 'missing', body: '# Title\nno header' });

    const invalid = readMarkdownFrontmatter('---\nnote: a: b\n---\nbody');
    expect(invalid.status).toBe('invalid');
    if (invalid.status !== 'invalid') return;
    expect(invalid.yaml).toBe('note: a: b');
    expect(invalid.body).toBe('body');
    expect(invalid.message).not.toBe('');
  });

  it('treats a header without a mapping as empty data', () => {
    expect(readMarkdownFrontmatter('---\n- a\n- b\n---\nbody')).toMatchObject({ status: 'parsed', data: {} });
  });
});

describe('readFrontmatterPairs', () => {
  const broken = 'memo: Note: colon inside';
  const pair = (yaml: string, key: string) => readFrontmatterPairs(yaml).find((p) => p.key === key);

  it('keeps each YAML spelling of a field next to a broken one', () => {
    expect(pair(`${broken}\nscope: personal # keep private`, 'scope')).toMatchObject({ value: 'personal' });
    expect(pair(`${broken}\nscope: [personal]`, 'scope')).toMatchObject({ value: ['personal'] });
    expect(pair(`${broken}\nscope:\n  - personal`, 'scope')).toMatchObject({ value: ['personal'] });
    expect(pair(`${broken}\n"scope": "personal"`, 'scope')).toMatchObject({ value: 'personal' });
  });

  it('reads in the whole document context: aliases to earlier anchors and explicit keys', () => {
    expect(pair(`classification: &privacy personal\n${broken}\nscope: *privacy`, 'scope')).toMatchObject({
      value: 'personal',
      resolved: true,
    });
    expect(pair(`${broken}\n? scope\n: personal`, 'scope')).toMatchObject({ value: 'personal' });
  });

  it('marks a value it cannot resolve instead of dropping the pair', () => {
    expect(pair(`${broken}\nscope: *missing`, 'scope')).toMatchObject({ resolved: false, value: undefined });
  });

  it('tells which fields were written at the start of a line, even where recovery nested them', () => {
    const pairs = readFrontmatterPairs(`name: Probe\n${broken}\ntype: reference\n? explicit\n: key`);
    const atLineStart = (key: string) => pairs.find((p) => p.key === key)?.atLineStart;
    expect([atLineStart('name'), atLineStart('memo'), atLineStart('type'), atLineStart('explicit')]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(atLineStart('Note')).toBe(false);
  });
});
