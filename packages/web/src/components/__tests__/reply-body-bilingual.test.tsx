import type { QuoteContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { CapabilityTipStrip } from '../CapabilityTipStrip';
import { CollapsibleMarkdown } from '../CollapsibleMarkdown';
import { ContextAttachmentView } from '../ContextAttachmentView';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex-astra' ? { displayName: '缅因猫 Astra' } : undefined),
  }),
}));
vi.mock('@/lib/capabilityTipEvents', () => ({ recordCapabilityTipEvent: vi.fn() }));

const quote: QuoteContextAttachment = {
  v: 1,
  id: 'quoted-reply',
  kind: 'quote',
  text: '原始引用 Keep this text',
  comment: '批注原文 Keep this comment',
  source: { kind: 'cli_output', threadId: 'source-thread', messageId: 'source-message', segmentId: 'stdout' },
};
const longContent = Array.from({ length: 35 }, (_, i) => `Paragraph ${i}`).join('\n');
const contexts = ['thinking' as const];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: [] });
  useChatStore.setState({
    currentThreadId: 'source-thread',
    messages: [{ id: 'source-message', type: 'assistant', catId: 'codex-astra', content: 'source', timestamp: 1 }],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetCoCreatorConfigCacheForTest();
  localStorage.clear();
});

function renderSurface(attachment = quote, onRemove?: () => void) {
  act(() =>
    root.render(
      <>
        <section data-testid="fold">
          <CollapsibleMarkdown content={longContent} />
        </section>
        <ContextAttachmentView attachment={attachment} onRemove={onRemove} />
        <CapabilityTipStrip contexts={contexts} surface="assistant_stream_bubble" firstDelayMs={0} />
      </>,
    ),
  );
}

describe('v2 reply copy uses the live shell language without replacing content', () => {
  it('keeps a known human author named, including the matching accessible remove name', () => {
    useChatStore.setState({ messages: [{ id: 'human', type: 'user', content: 'source', timestamp: 1 }] });
    renderSurface({ ...quote, source: { kind: 'message', threadId: 'source-thread', messageId: 'human' } }, vi.fn());
    expect(container.textContent).toContain('引用You 的回复');
    expect(container.querySelector('button[aria-label]')?.getAttribute('aria-label')).toBe('移除上下文 You 的回复');
    act(() => writeShellLanguage('en'));
    expect(container.querySelector('button[aria-label]')?.getAttribute('aria-label')).toBe(
      "Remove context You's reply",
    );
    act(() => primeCoCreatorConfigCache({ name: 'Alice', aliases: [], mentionPatterns: [] }));
    expect(container.textContent).toContain("QuoteAlice's reply");
    expect(container.querySelector('button[aria-label]')?.getAttribute('aria-label')).toBe(
      "Remove context Alice's reply",
    );
  });

  it('does not infer stdout provenance for a legacy CLI quote with no segment id', () => {
    renderSurface({ ...quote, source: { kind: 'cli_output', threadId: 'source-thread', messageId: 'source-message' } });
    expect(container.textContent).toContain('引用执行记录');
    expect(container.textContent).not.toContain('缅因猫 Astra 的回复');
  });

  it('uses the same localized title for visible and accessible copy, preserving classic remove text', () => {
    const remove = vi.fn();
    renderSurface(quote, remove);
    const button = container.querySelector('button[aria-label]') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('移除上下文 缅因猫 Astra 的回复');
    act(() => button.click());
    expect(remove).toHaveBeenCalledOnce();
    act(() => writeShellLanguage('en'));
    expect(button.getAttribute('aria-label')).toBe("Remove context 缅因猫 Astra's reply");
    act(() => writeShellPresentation('classic'));
    expect(container.querySelector('button[aria-label]')?.getAttribute('aria-label')).toBe('移除上下文 CLI Output');
  });

  it('changes the three labels in place and keeps an expanded reply and its original quote/comment', () => {
    renderSurface();
    const fold = container.querySelector('[data-testid="fold"] button') as HTMLButtonElement;
    const paragraph = container.querySelector('[data-testid="fold"] p');
    expect(fold.textContent).toBe('展开（还有 15 行）');
    expect(container.textContent).toContain('引用缅因猫 Astra 的回复');
    expect(container.textContent).toContain('批注批注原文 Keep this comment');
    expect(container.textContent).toContain('提示');
    act(() => fold.click());
    expect(fold.textContent).toBe('收起');
    act(() => writeShellLanguage('en'));
    expect(container.querySelector('[data-testid="fold"] p')).toBe(paragraph);
    expect(container.querySelector('[data-testid="fold"] button')).toBe(fold);
    expect(fold.textContent).toBe('Show less');
    expect(container.textContent).toContain("Quote缅因猫 Astra's reply");
    expect(container.textContent).toContain('Comment批注原文 Keep this comment');
    expect(container.textContent).toContain('原始引用 Keep this text');
    expect(container.textContent).toContain('Tip');
    act(() => fold.click());
    expect(fold.textContent).toBe('Show more (+15 lines)');
  });

  it.each(['zh', 'en'] as const)('keeps classic labels and behavior with the v2 preference set to %s', (language) => {
    writeShellPresentation('classic');
    writeShellLanguage(language);
    renderSurface();
    expect(container.textContent).toContain('Show more (+15 lines)');
    expect(container.textContent).toContain('QUOTECLI Output');
    expect(container.textContent).toContain('Comment批注原文 Keep this comment');
    expect(container.textContent).toContain('Tip');
    expect(container.textContent).not.toContain('缅因猫 Astra 的回复');
  });

  it('never borrows a sender from the active conversation for another thread with the same message id', () => {
    renderSurface({
      ...quote,
      source: { kind: 'cli_output', threadId: 'other-thread', messageId: 'source-message', segmentId: 'stdout' },
    });
    expect(container.textContent).toContain('引用回复');
    expect(container.textContent).not.toContain('缅因猫 Astra');
  });

  it('can name an explicit message-quote sender, but leaves unknown senders neutral', () => {
    renderSurface({
      ...quote,
      source: { kind: 'message', threadId: 'other-thread', messageId: 'absent', senderCatId: 'codex-astra' },
    });
    expect(container.textContent).toContain('缅因猫 Astra 的回复');
    renderSurface({
      ...quote,
      source: { kind: 'message', threadId: 'other-thread', messageId: 'absent', senderCatId: 'missing-cat' },
    });
    expect(container.textContent).toContain('引用回复');
    expect(container.textContent).not.toContain('missing-cat');
  });

  it('does not relabel a tool detail or a source file as an answer', () => {
    renderSurface({
      ...quote,
      source: { kind: 'cli_output', threadId: 'source-thread', messageId: 'source-message', segmentId: 'tool-t1' },
    });
    expect(container.textContent).toContain('引用执行记录');
    renderSurface({ ...quote, source: { kind: 'workspace_file', path: 'docs/a.md' } });
    expect(container.textContent).toContain('引用docs/a.md');
  });
});
