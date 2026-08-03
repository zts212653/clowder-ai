import type { PawFeelInboxPage } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'You', color: { primary: '#000000', secondary: '#ffffff' } }),
}));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentThreadId: 'thread-current',
      isLoadingThreads: false,
      threads: [],
      messages: [],
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    }),
  resolveBubbleExpanded: () => false,
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('span', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));
vi.mock('@/components/TtsPlayButton', () => ({ TtsPlayButton: () => null }));

const seenPage: PawFeelInboxPage = {
  generatedAt: '2026-07-26T00:00:00.000Z',
  projectionStatus: 'available',
  items: [
    {
      disposition: {
        signalId: 'signal-1',
        sourceMessageId: 'message-cat',
        sourceThreadId: 'thread-current',
        sourceCatId: 'codex-sol',
        markerDigest: 'digest',
        sameDigestOrdinal: 0,
        markerIndex: 0,
        state: 'seen',
        sequence: 2,
        discoveredAt: '2026-07-25T00:00:00.000Z',
        lastTransitionAt: '2026-07-26T00:00:00.000Z',
        lastActorCatId: 'sonnet',
        backfilled: false,
        captureMethod: 'typed',
        captureAssessment: 'confirmed',
      },
      source: {
        availability: 'available',
        preview: 'not rendered in the dock',
        sourceHref: '/thread/thread-current?messageId=message-cat',
        digestVerified: true,
      },
      ageMs: 3_600_000,
      overdue: false,
    },
  ],
  bundles: [],
  bundleCounts: {
    total: 1,
    byBasis: { message: 1, turn_invocation: 0, legacy_invocation: 0, single_signal: 0 },
  },
  denominator: {
    reportOccurrences: 1,
    uniqueSourceMessages: 1,
    historicalBackfill: 0,
    postActivationIntake: 1,
    typedConfirmed: 0,
    ambiguousOrContaminated: 1,
    reviewBundles: 1,
    problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
  },
  counts: { total: 1, unseen: 0, inProgress: 1, routePending: 0, disposed: 0, overdue: 0 },
  degraded: false,
};

function message(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'message-cat',
    type: 'assistant',
    catId: 'codex-sol',
    content: '[爪感差: hold_ball+完成回调丢失]',
    timestamp: Date.now(),
    isStreaming: false,
    ...overrides,
  };
}

describe('ChatMessage paw-feel disposition projection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{
    message: ChatMessageType;
    getCatById: (id: string) => CatData | undefined;
  }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ChatMessage = (await import('@/components/ChatMessage')).ChatMessage;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => seenPage,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(target: ChatMessageType) {
    await act(async () => {
      root.render(<ChatMessage message={target} getCatById={() => undefined} />);
    });
    await act(async () => {});
  }

  it('shows the cat-signed ledger state on the canonical source bubble', async () => {
    await render(message());

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/paw-feel/source/message-cat');
    expect(container.querySelector('[data-testid="paw-feel-disposition-dock"]')).not.toBeNull();
    expect(container.textContent).toContain('责任收件箱 · 1 条报告');
    expect(container.textContent).toContain('已看');
    expect(container.textContent).toContain('@sonnet');
    expect(container.textContent).not.toContain('not rendered in the dock');
  });

  it('lets the API suppress a responsibility dock for an inline syntax example with no source rows', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...seenPage,
        items: [],
        bundles: [],
        bundleCounts: {
          total: 0,
          byBasis: { message: 0, turn_invocation: 0, legacy_invocation: 0, single_signal: 0 },
        },
        denominator: {
          ...seenPage.denominator,
          reportOccurrences: 0,
          uniqueSourceMessages: 0,
          postActivationIntake: 0,
          ambiguousOrContaminated: 0,
          reviewBundles: 0,
        },
        counts: { total: 0, unseen: 0, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
      }),
    });

    await render(message({ content: '示例语法：`[爪感差: 工具+现象]`，不要复制正文。' }));

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/paw-feel/source/message-cat');
    expect(container.querySelector('[data-testid="paw-feel-disposition-dock"]')).toBeNull();
    expect(container.textContent).not.toContain('等待完整性对账登记');
    expect(container.textContent).not.toContain('责任收件箱');
  });

  it('renders one aggregate dock for multiple reports in the same source message', async () => {
    const baseItem = seenPage.items.at(0);
    if (!baseItem) throw new Error('seenPage fixture must contain one item');
    const second = {
      ...baseItem,
      disposition: {
        ...baseItem.disposition,
        signalId: 'signal-2',
        markerDigest: 'digest-2',
        markerIndex: 1,
        state: 'fix' as const,
        sequence: 2,
        ownerCatId: 'opus',
        lastActorCatId: 'opus',
        taskId: 'task-1',
        actionLeaseRef: { leaseId: 'lease-1', generation: 2 },
      },
    };
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...seenPage,
        items: [seenPage.items[0], second],
        counts: { total: 2, unseen: 0, inProgress: 1, routePending: 0, disposed: 1, overdue: 0 },
      }),
    });

    await render(message());

    expect(container.querySelectorAll('[data-testid="paw-feel-disposition-dock"]')).toHaveLength(1);
    expect(container.textContent).toContain('责任收件箱 · 2 条报告');
    expect(container.textContent).toContain('已看 1');
    expect(container.textContent).toContain('已确认要修 1');
    expect(container.textContent).toContain('最近审阅 @opus');
    expect(container.textContent).not.toContain('marker #');
    expect(container.querySelectorAll('[data-testid="paw-feel-disposition-detail"]')).toHaveLength(0);

    const disclosure = container.querySelector('details');
    await act(async () => {
      disclosure?.setAttribute('open', '');
      disclosure?.dispatchEvent(new Event('toggle', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="paw-feel-disposition-detail"]')).toHaveLength(2);
  });

  it('attributes the latest review actor from the newest transition rather than response order', async () => {
    const baseItem = seenPage.items.at(0);
    if (!baseItem) throw new Error('seenPage fixture must contain one item');
    const older = {
      ...baseItem,
      disposition: {
        ...baseItem.disposition,
        lastTransitionAt: '2026-07-25T00:00:00.000Z',
        lastActorCatId: 'sonnet',
      },
    };
    const newer = {
      ...baseItem,
      disposition: {
        ...baseItem.disposition,
        signalId: 'signal-2',
        markerDigest: 'digest-2',
        markerIndex: 1,
        lastTransitionAt: '2026-07-27T00:00:00.000Z',
        lastActorCatId: 'kimi',
      },
    };
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...seenPage,
        items: [newer, older],
        counts: { total: 2, unseen: 0, inProgress: 2, routePending: 0, disposed: 0, overdue: 0 },
      }),
    });

    await render(message());

    expect(container.textContent).toContain('最近审阅 @kimi');
    expect(container.textContent).not.toContain('最近审阅 @sonnet');
  });

  it('does not create a second projection on a cross-thread copy', async () => {
    await render(
      message({
        id: 'message-copy',
        extra: { crossPost: { sourceThreadId: 'thread-source' } },
      }),
    );

    expect(container.querySelector('[data-testid="paw-feel-disposition-dock"]')).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('does not treat a user-authored marker as a cat-authored F278 signal', async () => {
    await render(
      message({
        id: 'message-user',
        type: 'user',
        catId: undefined,
      }),
    );

    expect(container.querySelector('[data-testid="paw-feel-disposition-dock"]')).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
