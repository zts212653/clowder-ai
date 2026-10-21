import React, { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { MessageActionSlot } from '../MessageActionSlot';
import { MessageActions } from '../MessageActions';
import { writeShellLanguage } from '../shell/shell-language';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), api: vi.fn() }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: mocks.synthesize, activeMessageId: null }),
}));
vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => null }));
vi.mock('../useMessageAnnotationMarkers', () => ({ useMessageAnnotationMarkers: () => [] }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));

describe('F322 reading header and transient actions', () => {
  let h: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    primeCoCreatorConfigCache({
      name: 'You',
      aliases: [],
      mentionPatterns: ['@co-creator'],
      avatar: '/avatars/owner.jpg',
    });
    h = new ReplyLayersHarness();
    mocks.synthesize.mockReset();
    mocks.api.mockResolvedValue(new Response('{}', { status: 503 }));
  });
  afterEach(() => {
    h.dispose();
    writeShellLanguage('zh');
  });

  it('keeps copy-id and speech out of the v2 name row while preserving the classic name row', () => {
    const message = streamReply();
    h.render(message);
    const classic = h.q('message-header')!.innerHTML;
    // Copy is owned by MessageActions; a bare ChatMessage does not add a second header control.
    expect(classic).not.toContain('复制消息 ID');
    // Approved classic parity keeps speech in MessageActions, outside the name row.
    expect(classic).not.toContain('播放语音');
    h.enableV2();
    h.render(message);
    const header = h.q('message-header')!;
    expect(header.querySelector('button[title="播放语音"]')).toBeNull();
    expect(header.querySelector('button[aria-label^="复制消息 ID"]')).toBeNull();
  });
  it('puts cross-thread provenance on the letter, outside the author row', () => {
    h.enableV2();
    useChatStore.setState({
      threads: [
        {
          id: 'thread-source',
          title: 'Design Source',
          createdAt: 1,
          projectPath: '/work',
          createdBy: 'operator',
          participants: [],
          lastActiveAt: 1,
        },
      ],
    });
    h.render(
      streamReply({ extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'source-turn' } } }),
    );
    const pill = h.container.querySelector('[data-cross-thread-letter]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain('Design Source');
    expect(pill!.closest('[data-message-author-row]')).toBeNull();
    expect(h.container.textContent).not.toContain('📮');
    expect(pill!.querySelector('a')?.getAttribute('href')).toBe('/thread/thread-source');
  });
  it("keeps a retired source cat's cross-thread provenance visible without reviving its nameplate", async () => {
    const message = streamReply({
      catId: 'retired-source-cat',
      extra: { crossPost: { sourceThreadId: 'thread-source' } },
    });
    h.render(message);
    h.enableV2();
    await act(async () => h.render(message));
    const pill = h.container.querySelector('[data-cross-thread-letter]');
    expect(pill).not.toBeNull();
    expect(pill?.querySelector('a')?.getAttribute('href')).toBe('/thread/thread-source');
    expect(pill?.textContent).toContain('标题读不到');
    expect(pill?.closest('[data-message-author-row]')).toBeNull();
    expect(h.container.textContent).not.toContain('📮');
  });
  it('keeps the narrow v2 slot at zero resting size and moves read-aloud and copy into the actual toolbar', async () => {
    h.enableV2();
    const message = streamReply();
    act(() =>
      h.root.render(
        <MessageActions message={message} threadId="thread-1" selectionEligible onEnterSelection={() => {}}>
          <div data-message-author-row>
            <span>Author · Time</span>
            <MessageActionSlot />
          </div>
        </MessageActions>,
      ),
    );
    const slot = h.container.querySelector('[data-message-action-slot]');
    expect(slot?.className).not.toContain('max-md:h-11');
    const read = document.querySelector<HTMLButtonElement>(
      '[data-message-actions-owner="reply-1"] [aria-label="朗读"]',
    );
    expect(read?.closest('[role="toolbar"]')).not.toBeNull();
    act(() => read!.click());
    expect(mocks.synthesize).toHaveBeenCalledWith(message.id, message.content, message.catId);
    const more = document.querySelector<HTMLButtonElement>(
      '[data-message-actions-owner="reply-1"] [aria-label="更多消息操作"]',
    );
    act(() => more!.click());
    expect(document.querySelector('[role="menuitem"][aria-label="复制消息 ID"]')).not.toBeNull();
  });
});
