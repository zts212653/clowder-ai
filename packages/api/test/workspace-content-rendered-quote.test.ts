import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWorkspaceRenderedQuote } from '../src/domains/workspace/workspace-content-rendered-quote.js';

const markdownQuote = (text: string, quote: string) => resolveWorkspaceRenderedQuote({ text, quote, markdown: true });

describe('rendered selection → raw range (F309 "请猫修改" target)', () => {
  it('maps a unique rendered quote through bold, links and list markers to one raw range', () => {
    const text = '- 见 [**链接文字**](/docs/x.md) 然后继续\n- 另一项\n';
    const result = markdownQuote(text, '链接文字 然后');
    assert.equal(result.status, 'attached');
    assert.equal(result.anchor?.start, text.indexOf('链接文字'));
    assert.equal(result.anchor?.end, text.indexOf('然后') + 2);
    assert.equal(result.anchor?.quote, text.slice(text.indexOf('链接文字'), text.indexOf('然后') + 2));
  });

  it('refuses an end that has no single source character instead of cutting a reference', () => {
    const text = 'Tom &amp; Jerry went home.\n';
    assert.equal(markdownQuote(text, 'Tom &').status, 'orphaned');
    const jerry = markdownQuote(text, 'Jerry went');
    assert.equal(jerry.status, 'attached');
    assert.equal(jerry.anchor?.quote, 'Jerry went');
  });

  it('refuses a whole file whose renderer generates text the source does not have', () => {
    assert.equal(markdownQuote('脚注在这里[^1]。\n\n[^1]: 注释\n', '脚注在这里').status, 'ambiguous');
    assert.equal(markdownQuote('$$\nE=mc^2\n$$\n\n正文一句\n', '正文一句').status, 'ambiguous');
  });

  it('never strips markup to guess: absent visible text is orphaned, repeated visible text is ambiguous', () => {
    assert.equal(markdownQuote('**同一句**\n\n同一句\n', '同一句').status, 'ambiguous');
    assert.equal(markdownQuote('这里只有 **加粗**\n', '只有 **加粗**').status, 'orphaned');
  });

  it('keeps raw-rendered files on the exact raw matcher', () => {
    const raw = resolveWorkspaceRenderedQuote({ text: 'a **b** c', quote: 'a b', markdown: false });
    assert.equal(raw.status, 'orphaned');
    assert.equal(
      resolveWorkspaceRenderedQuote({ text: 'a **b** c', quote: '**b**', markdown: false }).status,
      'attached',
    );
  });

  // codex6-sol #4750 review: offsets counted code points, so after an emoji every anchor pointed one unit off
  // and still passed `text.slice(start, end) === quote` downstream.
  it('maps selections after characters outside the BMP to the exact raw units', () => {
    const text = '`😀` after words';
    const after = markdownQuote(text, 'after');
    assert.equal(after.status, 'attached');
    assert.deepEqual([after.anchor?.start, after.anchor?.end, after.anchor?.quote], [5, 10, 'after']);
    const emoji = markdownQuote(text, '😀');
    assert.equal(emoji.status, 'attached');
    assert.deepEqual([emoji.anchor?.start, emoji.anchor?.quote], [1, '😀']);
    const words = markdownQuote(text, 'words');
    assert.equal(words.status, 'attached');
    assert.equal(words.anchor?.quote, 'words');
    const bold = markdownQuote('前 🐾 **加粗 🐾 词** 后\n', '粗 🐾 词');
    assert.equal(bold.status, 'attached');
    assert.equal(bold.anchor?.quote, '粗 🐾 词');
  });
});
