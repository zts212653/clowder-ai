import { describe, expect, it } from 'vitest';
import { extractListenSentences } from '../markdown-sentences';

const fixture = `---
title: 不应朗读
owner: sol
---

# 研究方法

第一句。第二句有**加粗文本**，并且跨越格式！

> 引用一句。引用二句？

- 重复句。
- 重复句。

说明见 https://example.com/research 。最后一句。

| 列一 | 列二 |
| --- | --- |
| 表格内容 | 不朗读 |

\`\`\`ts
const secret = '代码不朗读。';
\`\`\`
`;

describe('F279 semantic Markdown sentence projection', () => {
  it('projects only readable semantic nodes and skips frontmatter, code, tables, and bare URLs', () => {
    const sentences = extractListenSentences(fixture);

    expect(sentences.map((sentence) => sentence.text)).toEqual([
      '研究方法',
      '第一句。',
      '第二句有加粗文本，并且跨越格式！',
      '引用一句。',
      '引用二句？',
      '重复句。',
      '重复句。',
      '说明见。',
      '最后一句。',
    ]);
    expect(sentences.map((sentence) => sentence.text).join('')).not.toMatch(
      /不应朗读|owner|代码不朗读|表格内容|https:/,
    );
  });

  it('keeps one logical sentence across inline formatting with source fragments for rendering', () => {
    const [sentence] = extractListenSentences('这句包含**重点**与*语气*，但仍是一句话。');

    expect(sentence?.text).toBe('这句包含重点与语气，但仍是一句话。');
    expect(sentence?.fragments.length).toBeGreaterThan(1);
    expect(
      sentence?.fragments
        .map(({ start, end }) => '这句包含**重点**与*语气*，但仍是一句话。'.slice(start, end))
        .join(''),
    ).toBe('这句包含重点与语气，但仍是一句话。');
  });

  it('gives duplicate sentences distinct occurrence anchors and stable unique anchors after unrelated edits', () => {
    const duplicates = extractListenSentences('重复句。重复句。');
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((sentence) => sentence.occurrence)).toEqual([0, 1]);
    expect(duplicates[0]?.anchor).not.toBe(duplicates[1]?.anchor);

    const before = extractListenSentences('目标句。');
    const after = extractListenSentences('前面新增一句。\n\n目标句。');
    expect(after.find((sentence) => sentence.text === '目标句。')?.anchor).toBe(before[0]?.anchor);
  });

  it('preserves source ordering and monotonic indexes for multilingual punctuation', () => {
    const sentences = extractListenSentences('First sentence. 第二句！Third one? 尾句没有标点');

    expect(sentences.map((sentence) => sentence.text)).toEqual([
      'First sentence.',
      '第二句！',
      'Third one?',
      '尾句没有标点',
    ]);
    expect(sentences.map((sentence) => sentence.index)).toEqual([0, 1, 2, 3]);
    expect(sentences.every((sentence) => sentence.sourceStart < sentence.sourceEnd)).toBe(true);
  });
});
