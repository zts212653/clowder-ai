import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workCardTime } from '@/components/artifacts/work-card-message-context';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

/**
 * F335 交付三 (review #6579 P1): the work card footer is driven by the real message it sits in. A reply the watcher
 * wrote carries `extra.turnExecution.executionKind = 'watcher'`; its card footer must read 「守望猫 · 名字 · …」.
 * Real ChatMessage → RichBlocks → LivingWorkCard → ChatWorkCard; only the network and the cat roster are stubbed.
 */
const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => fetcher(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCatData')>()),
  useCatData: () => ({ getCatById: () => undefined, cats: [] }),
}));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
const card = {
  id: 'work-reference-sheet',
  v: 1 as const,
  kind: 'card' as const,
  title: '六猫岛 · 单采肖像参考',
  bodyMarkdown: '',
  meta: { kind: 'work_reference', reference },
};
const at = new Date(2026, 10, 2, 2, 5).getTime();
const cat = (id: string): CatData =>
  ({ id, displayName: id, color: { primary: '#888', secondary: '#eee' } }) as CatData;

function reply(executionKind?: 'watcher' | 'ordinary'): ChatMessageType {
  return {
    id: `msg-${executionKind ?? 'plain'}`,
    type: 'assistant',
    catId: 'codex61-sol',
    origin: 'stream',
    content: '鲸鲸照成员资料里那张头像就行。',
    contentBlocks: [],
    timestamp: at,
    isStreaming: false,
    extra: {
      rich: { v: 1, blocks: [card] },
      ...(executionKind
        ? { turnExecution: { invocationId: 'inv-w', parentInvocationId: 'inv-w', executionKind } }
        : {}),
    },
  } as unknown as ChatMessageType;
}

describe('F335 交付三 chat work card footer in a real ChatMessage', () => {
  let ChatMessage: React.FC<{ message: ChatMessageType; getCatById: (id: string) => CatData | undefined }>;
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ChatMessage = (await import('@/components/ChatMessage')).ChatMessage;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    fetcher.mockResolvedValue({
      ok: true,
      json: async () => ({
        asset: { ...reference, mediaType: 'text/html', blobDigest: `sha256:${'b'.repeat(64)}` },
        currentOwnerRevision: 1,
      }),
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    vi.clearAllMocks();
  });

  const footer = () => host.querySelector('.chat-work-card small')?.textContent;
  const render = (message: ChatMessageType) =>
    act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId="thread-video">
          <ChatMessage message={message} getCatById={cat} />
        </ArtworkLightboxProvider>,
      ),
    );

  it('a watcher reply names the watcher; an ordinary reply names only the cat', async () => {
    await render(reply('watcher'));
    expect(footer()).toBe(`守望猫 · codex61-sol · 第 1 版 · ${workCardTime(at)}`);
    await render(reply('ordinary'));
    expect(footer()).toBe(`codex61-sol · 第 1 版 · ${workCardTime(at)}`);
    await render(reply());
    expect(footer()).toBe(`codex61-sol · 第 1 版 · ${workCardTime(at)}`);
  });
});
