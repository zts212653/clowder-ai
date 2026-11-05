import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { refreshCoCreatorMentionData, refreshMentionData } from '@/lib/mention-highlight';
import { useChatStore } from '@/stores/chatStore';
import { consumePendingCrossPostScroll } from '@/utils/crosspost-scroll-target';
import { writeShellLanguage } from '../shell/shell-language';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api(...args) }));

const source = {
  id: 'thread-source',
  title: '设计源',
  createdAt: 1,
  lastActiveAt: 1,
  projectPath: '/work',
  createdBy: 'operator',
  participants: [],
};
const letter = (content = '@codex-astra\n\n别处发来的信。', targets?: string[]) =>
  streamReply({
    origin: 'callback',
    content,
    toolEvents: [],
    extra: {
      crossPost: { sourceThreadId: source.id, sourceInvocationId: 'source-turn' },
      ...(targets ? { targetCats: targets } : {}),
    },
  });

describe('v2 cross-thread letter through ChatMessage', () => {
  let h: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    h.enableV2();
    api.mockReset();
    api.mockResolvedValue(new Response('{}', { status: 503 }));
    primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: ['@co-creator'] });
    refreshCoCreatorMentionData(['@co-creator']);
    refreshMentionData([
      {
        id: 'codex-astra',
        displayName: 'Astra',
        mentionPatterns: ['@codex-astra'],
        color: { primary: '#555' },
      } as never,
    ]);
    useChatStore.setState({ threads: [source] });
  });
  afterEach(() => {
    h.dispose();
    writeShellLanguage('zh');
  });
  const paper = () => h.container.querySelector<HTMLElement>('[data-cross-thread-letter]');

  it('frames the body under the unchanged author nameplate and removes the cat rail and duplicate source labels', () => {
    h.render(letter());
    expect(paper()).not.toBeNull();
    expect(paper()?.textContent).toContain('来信');
    expect(paper()?.textContent).toContain('设计源');
    expect(paper()?.textContent).toContain('别处发来的信。');
    expect(h.q('cat-nameplate')).not.toBeNull();
    expect(h.container.querySelector('[data-reply-color-rail]')).toBeNull();
    expect(h.container.querySelector('[data-cross-thread-source-pill]')).toBeNull();
    expect(h.q('message-header')?.textContent).not.toContain('↗');
    expect(api.mock.calls.filter(([url]) => String(url).startsWith('/api/threads/'))).toEqual([]);
  });
  it('uses explicit targets before mentions and gives each target its own cat color', () => {
    h.render(letter('@co-creator\nIgnored mention', ['codex-astra']));
    const recipient = paper()?.querySelector<HTMLElement>('[data-letter-recipient="codex-astra"]');
    expect(recipient?.textContent).toContain('Astra');
    expect(recipient?.style.color).toBe('var(--color-codex-astra-text)');
    expect(paper()?.querySelector('[data-letter-recipient="__co-creator__"]')).toBeNull();
  });
  it('reads line-start mentions, including list prefixes, but ignores inline prose and code blocks', () => {
    h.render(letter('Inline @co-creator\n```\n@co-creator\n```\n- @codex-astra\n\n正文'));
    expect(paper()?.querySelector('[data-letter-recipient="codex-astra"]')).not.toBeNull();
    expect(paper()?.querySelector('[data-letter-recipient="__co-creator__"]')).toBeNull();
  });
  it('shows a solid human badge for a letter addressed to the owner', () => {
    h.render(letter('@co-creator\n请你判断。'));
    const recipient = paper()?.querySelector<HTMLElement>('[data-letter-recipient="__co-creator__"]');
    expect(recipient?.textContent).toBe('@你');
    expect(recipient?.style.backgroundColor).toBe('var(--shell-primary)');
  });
  it('omits the recipient arrow when the letter has no named recipient', () => {
    h.render(letter('没有指定收信人。'));
    expect(paper()).not.toBeNull();
    expect(paper()?.querySelector('[data-letter-recipients]')).toBeNull();
  });
  it('uses the persisted owner-mention fact for configured aliases without creating attention state', () => {
    h.render({ ...letter('@co-creator请看。'), mentionsUser: true });
    expect(paper()?.querySelector('[data-letter-recipient="__co-creator__"]')?.textContent).toBe('@你');
  });
  it('jumps to the source invocation with the existing pending-scroll and history owners', () => {
    h.render(letter());
    const link = paper()?.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe('/thread/thread-source');
    act(() => link!.click());
    expect(window.location.pathname).toBe('/thread/thread-source');
    expect(consumePendingCrossPostScroll('thread-source')).toMatchObject({
      sourceInvocationId: 'source-turn',
      senderCatId: 'opus',
    });
  });
  it('fetches an unloaded source by its exact id and displays its title', async () => {
    useChatStore.setState({ threads: [] });
    api.mockResolvedValue(new Response(JSON.stringify(source)));
    await act(async () => h.render(letter()));
    expect(api).toHaveBeenCalledWith('/api/threads/thread-source', expect.any(Object));
    expect(paper()?.textContent).toContain('设计源');
  });
  it('disables navigation only when deletion is confirmed by the source record', async () => {
    useChatStore.setState({ threads: [] });
    api.mockResolvedValue(new Response(JSON.stringify({ ...source, deletedAt: 12 })));
    await act(async () => h.render(letter()));
    expect(paper()?.textContent).toContain('一个已删除的对话');
    expect(paper()?.querySelector('a')).toBeNull();
  });
  it.each([
    403, 404, 503,
  ])('keeps navigation on an unreadable source (%s), without guessing deletion', async (status) => {
    useChatStore.setState({ threads: [] });
    api.mockResolvedValue(new Response('{}', { status }));
    await act(async () => h.render(letter()));
    expect(paper()?.textContent).toContain('标题读不到');
    expect(paper()?.textContent).not.toContain('已删除');
    expect(paper()?.querySelector('a')).not.toBeNull();
  });
  it('uses English labels and preserves the original body', () => {
    writeShellLanguage('en');
    h.render(letter('@co-creator\n原文不翻译。'));
    expect(paper()?.textContent).toContain('Letter');
    expect(paper()?.textContent).toContain('Go to source');
    expect(paper()?.textContent).toContain('@you');
    expect(paper()?.textContent).toContain('原文不翻译。');
  });
  it('also frames letters from retired authors without creating a nameplate for them', () => {
    h.render({ ...letter(), catId: 'retired-cat' });
    expect(paper()).not.toBeNull();
    expect(h.q('cat-nameplate')).toBeNull();
    expect(h.container.querySelector('[data-reply-color-rail]')).toBeNull();
  });
  it('does not turn same-thread callback provenance into a letter', () => {
    h.render(streamReply({ extra: { crossPost: { sourceThreadId: 'thread-1' } } }));
    expect(paper()).toBeNull();
  });
  it('preserves the classic mailbox capsule without fetching new source details', () => {
    window.localStorage.setItem('cat-cafe:shell-presentation', 'classic');
    h.render(letter());
    expect(paper()).toBeNull();
    expect(h.container.textContent).toContain('📮');
    expect(h.container.textContent).toContain('↗ thread-s');
    expect(api.mock.calls.filter(([url]) => String(url).startsWith('/api/threads/'))).toEqual([]);
  });
});
