import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const capturedComponents = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('react-markdown', () => ({
  default: ({ components }: { components: Record<string, unknown> }) => {
    capturedComponents.push(components);
    return <div />;
  },
}));

import { MarkdownContent } from '@/components/MarkdownContent';
import { extractListenSentences } from '@/lib/listen-mode/markdown-sentences';

function render(props: ComponentProps<typeof MarkdownContent>): void {
  renderToStaticMarkup(<MarkdownContent {...props} />);
}

describe('MarkdownContent listen component scope', () => {
  beforeEach(() => capturedComponents.splice(0));

  it('does not override generic span rendering outside listen mode', () => {
    render({ content: '普通 Markdown。' });
    expect(capturedComponents.at(-1)?.span).toBeUndefined();
  });

  it('installs the sentence span renderer only when listen projection is active', () => {
    const content = '可听正文。';
    const listenSentences = extractListenSentences(content);
    render({ content, listenSentences, onListenSentenceStart: vi.fn() });
    expect(capturedComponents.at(-1)?.span).toBeTypeOf('function');
  });
});
