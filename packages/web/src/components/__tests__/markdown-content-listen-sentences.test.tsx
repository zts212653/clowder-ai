// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { extractListenSentences } from '@/lib/listen-mode/markdown-sentences';

describe('MarkdownContent listen sentence projection', () => {
  it('keeps inline Markdown while fragments share one logical sentence anchor', () => {
    const content = '这是**非常重要的**一句话。下一句。';
    const sentences = extractListenSentences(content);
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={content}
        disableCommandPrefix
        listenSentences={sentences}
        activeListenAnchor={sentences[0]?.anchor}
        onListenSentenceStart={vi.fn()}
      />,
    );

    expect(html).toContain('<strong');
    expect(html).toContain('非常重要的');
    expect(
      html.match(new RegExp(`data-listen-sentence-anchor="${sentences[0]?.anchor}"`, 'g'))?.length,
    ).toBeGreaterThan(1);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(`data-listen-sentence-anchor="${sentences[1]?.anchor}"`);
  });

  it('does not make skipped table or code content listenable', () => {
    const content = ['正文。', '', '| 表头 |', '| --- |', '| 单元格。 |', '', '```txt', '代码。', '```'].join('\n');
    const sentences = extractListenSentences(content);
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={content}
        disableCommandPrefix
        listenSentences={sentences}
        onListenSentenceStart={vi.fn()}
      />,
    );

    expect(sentences.map((sentence) => sentence.text)).toEqual(['正文。']);
    expect(html.match(/data-listen-sentence-anchor=/g)).toHaveLength(1);
    expect(html).toContain('单元格。');
    expect(html).toContain('代码。');
  });

  it('preserves the rendered sentence tree when listen props are referentially stable', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const content = '第一句。第二句。';
    const sentences = extractListenSentences(content);
    const onStart = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    const renderView = () => (
      <MarkdownContent
        content={content}
        disableCommandPrefix
        listenSentences={sentences}
        activeListenAnchor={sentences[0]?.anchor}
        onListenSentenceStart={onStart}
      />
    );
    act(() => root.render(renderView()));
    const firstSentence = container.querySelector(`[data-listen-sentence-anchor="${sentences[0]?.anchor}"]`);

    act(() => root.render(renderView()));

    expect(container.querySelector(`[data-listen-sentence-anchor="${sentences[0]?.anchor}"]`)).toBe(firstSentence);
    act(() => root.unmount());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
