import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/components/useConfirm');

const mockFetchPending = vi.fn(async () => {});
const mockApiFetch = vi.fn();
const mockInvalidateSidebarProjection = vi.fn(async () => true);

const threads = [
  {
    id: 'thread-1',
    title: 'F292 产品讨论',
    projectPath: '/workspace/cat-cafe',
    createdBy: 'owner-1',
    participants: ['codex-sol'],
    lastActiveAt: 200,
    createdAt: 100,
  },
  ...Array.from({ length: 1_200 }, (_, index) => ({
    id: `archive-${index}`,
    title: `历史 Thread ${index}`,
    projectPath: '/workspace/archive',
    createdBy: 'owner-1',
    participants: [],
    lastActiveAt: 100 - index,
    createdAt: index,
  })),
  {
    id: 'system-1',
    title: '系统',
    projectPath: '/workspace/cat-cafe',
    createdBy: 'system',
    participants: [],
    lastActiveAt: 300,
    createdAt: 300,
  },
];

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ fetchPending: mockFetchPending }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      threads,
      currentProjectPath: '/workspace/cat-cafe',
      isLoadingThreads: false,
    }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: () => mockInvalidateSidebarProjection(),
}));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string }) => cat.displayName,
  useCatData: () => ({
    cats: [
      {
        id: 'codex-sol',
        displayName: '小太阳·砚砚',
        clientId: 'openai',
        defaultModel: 'gpt-5.6-sol',
        avatar: '',
        roleDescription: '',
        personality: '',
        color: { primary: '#000000', secondary: '#ffffff' },
        mentionPatterns: [],
        roster: { family: 'maine-coon', roles: [], lead: true, available: true, evaluation: '' },
      },
      {
        id: 'disabled-cat',
        displayName: '暂不可用猫猫',
        clientId: 'test',
        defaultModel: 'test',
        avatar: '',
        roleDescription: '',
        personality: '',
        color: { primary: '#000000', secondary: '#ffffff' },
        mentionPatterns: [],
        roster: { family: 'test', roles: [], lead: false, available: false, evaluation: '' },
      },
    ],
    isLoading: false,
  }),
}));

import { MeetingIntakeCard } from '../MeetingIntakeCard';
import { ConfirmProvider } from '../useConfirm';

function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
}

const item = {
  proposalId: 'intake-1',
  sourceFeatureId: 'F292' as const,
  requesterCatId: 'system',
  ownerUserId: 'owner-1',
  status: 'pending' as const,
  summary: '整理会议：Weekly sync',
  detail: {
    revision: 1,
    sourceState: 'ready',
    judgmentState: 'unresolved',
    executionState: 'idle',
    healthState: 'healthy',
    unresolved: ['speakers', 'context', 'destination', 'outputs'],
    choices: {},
    metadata: { title: 'Weekly sync' },
    source: { handle: 'feishu://meeting-artifacts/minute/om_1?revision=1' },
  },
  navigation: { state: 'legacy_unanchored' as const },
  inlineApprovable: false,
  decisionMode: 'meeting-intake' as const,
  createdAt: 1,
};

describe('F292 MeetingIntakeCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockApiFetch.mockReset();
    mockFetchPending.mockClear();
    mockInvalidateSidebarProjection.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderCard(renderedItem = item): Promise<void> {
    await act(async () =>
      root.render(
        React.createElement(ConfirmProvider, null, React.createElement(MeetingIntakeCard, { item: renderedItem })),
      ),
    );
  }

  function buttonWithText(text: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === text);
  }

  it('collects speakers, context, existing private thread, and outputs before exact-revision confirm', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ intake: { revision: 4 } }) });
    await renderCard();

    expect(container.textContent).toContain('等你确认');
    expect(container.textContent).toContain('为什么需要我');
    expect(container.textContent).toContain('会议记录已经准备好了');
    expect(container.textContent).toContain('Weekly sync');
    expect(container.textContent).toContain('发言人称呼');
    expect(container.textContent).toContain('保存位置');
    expect(container.textContent).not.toContain('Needs Me');
    expect(container.textContent).not.toContain('rev 1');
    expect(container.textContent).not.toContain('说话人映射');
    expect(container.textContent).not.toContain('投递到私有 Thread');
    expect(container.textContent).not.toContain('/workspace/cat-cafe');
    expect(container.textContent).not.toContain('系统');
    expect(container.querySelector('[data-testid="approval-action-reason"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-recommendation"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-current-decision"]')).not.toBeNull();
    const sourceDetails = container.querySelector<HTMLDetailsElement>('[data-testid="meeting-source-details"]');
    expect(sourceDetails?.open).toBe(false);
    expect(sourceDetails?.textContent).toContain('feishu://meeting-artifacts/minute/om_1?revision=1');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(8);

    const speaker = container.querySelector('[data-testid="meeting-speakers"]') as HTMLTextAreaElement;
    const context = container.querySelector('[data-testid="meeting-context"]') as HTMLTextAreaElement;
    const destinationSearch = container.querySelector('[data-testid="meeting-destination-search"]') as HTMLInputElement;
    const output = container.querySelector('[data-testid="meeting-output-minutes"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(speaker, '1=You');
      speaker.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      setNativeValue(context, 'Architecture review');
      context.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      setNativeValue(destinationSearch, 'F292');
      destinationSearch.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('历史 Thread 0');
    await act(async () => {
      (container.querySelector('[data-testid="meeting-destination-thread-1"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      output.click();
    });
    const confirm = container.querySelector('[data-testid="meeting-confirm"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());

    expect(mockApiFetch).toHaveBeenCalledWith('/api/meeting-intakes/intake-1/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Architecture review',
          destinationHandle: 'host:private-thread:thread-1',
          outputs: ['minutes'],
        },
      }),
    });
    expect(mockFetchPending).toHaveBeenCalled();
  });

  it('creates an explicitly cat-bound private Thread, then confirms it as a deliverable destination', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'thread-created',
        title: 'Weekly sync 跟进',
        projectPath: '/workspace/cat-cafe',
        createdBy: 'owner-1',
        participants: [],
        preferredCats: ['codex-sol'],
        lastActiveAt: 400,
        createdAt: 400,
      }),
    });
    mockApiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ intake: { revision: 4 } }) });
    await renderCard();

    expect(container.querySelector('select[data-testid="meeting-destination"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="meeting-destination-create-toggle"]') as HTMLButtonElement).click();
    });
    const title = container.querySelector('[data-testid="meeting-destination-create-title"]') as HTMLInputElement;
    expect(title.value).toContain('Weekly sync');
    const createButton = container.querySelector(
      '[data-testid="meeting-destination-create-confirm"]',
    ) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    expect(container.textContent).not.toContain('暂不可用猫猫');
    await act(async () => {
      (container.querySelector('[data-testid="meeting-workflow-cat-codex-sol"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      setNativeValue(title, 'Weekly sync 跟进');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      createButton.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Weekly sync 跟进',
        projectPath: '/workspace/cat-cafe',
        preferredCats: ['codex-sol'],
        pinned: true,
      }),
    });
    expect(container.textContent).toContain('已选择：Weekly sync 跟进');
    expect(mockInvalidateSidebarProjection).toHaveBeenCalledTimes(1);

    const speaker = container.querySelector('[data-testid="meeting-speakers"]') as HTMLTextAreaElement;
    const context = container.querySelector('[data-testid="meeting-context"]') as HTMLTextAreaElement;
    const output = container.querySelector('[data-testid="meeting-output-minutes"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(speaker, '1=You');
      speaker.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(context, 'Architecture review');
      context.dispatchEvent(new Event('input', { bubbles: true }));
      output.click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="meeting-confirm"]') as HTMLButtonElement).click();
    });
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/meeting-intakes/intake-1/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Architecture review',
          destinationHandle: 'host:private-thread:thread-created',
          outputs: ['minutes'],
        },
      }),
    });
  });

  it('binds a cat to a confirmed no-cat destination and retries without resubmitting saved choices', async () => {
    const repairItem = {
      ...item,
      detail: {
        ...item.detail,
        revision: 4,
        judgmentState: 'confirmed',
        executionState: 'failed',
        healthState: 'degraded',
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Saved context',
          destinationHandle: 'host:private-thread:archive-0',
          outputs: ['minutes', 'decisions'],
        },
        repair: { code: 'route_unavailable', action: 'retry', observedAt: 2 },
      },
    };
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ preferredCats: ['codex-sol'] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ intake: { revision: 7 } }) });

    await renderCard(repairItem);

    expect(container.textContent).toContain('保存位置还没有负责整理的猫猫');
    expect(container.textContent).toContain('已经填写的内容会保留');
    expect(container.querySelector('[data-testid="meeting-retry"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="meeting-workflow-cat-codex-sol"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-testid="meeting-bind-cat-retry"]') as HTMLButtonElement).click();
    });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/threads/archive-0', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredCats: ['codex-sol'] }),
    });
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/meeting-intakes/intake-1/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 4 }),
    });
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/meeting-intakes/intake-1/confirm')).toBe(false);
  });

  it('keeps the primary decision above the fold when the suggested choices are complete', async () => {
    const readyItem = {
      ...item,
      detail: {
        ...item.detail,
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Architecture review',
          destinationHandle: 'host:private-thread:thread-1',
          outputs: ['minutes'],
        },
      },
    };
    await renderCard(readyItem);

    expect(container.querySelector('[data-testid="meeting-confirm"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="meeting-speakers"]')).toBeNull();
    expect(container.textContent).toContain('F292 产品讨论');

    await act(async () => {
      (container.querySelector('[data-testid="meeting-edit-toggle"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="meeting-speakers"]')).not.toBeNull();
  });

  it('renders the typed manual-import repair action without generic approve/reject', async () => {
    const repairItem = {
      ...item,
      detail: {
        ...item.detail,
        revision: 3,
        judgmentState: 'confirmed',
        executionState: 'failed',
        healthState: 'degraded',
        repair: { code: 'source_deleted', action: 'manual_import', observedAt: 2 },
      },
    };
    await renderCard(repairItem);
    const reference = container.querySelector('[data-testid="meeting-manual-reference"]') as HTMLInputElement;
    expect(reference).not.toBeNull();
    expect(container.textContent).not.toContain('粘贴会议文字稿');
    expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="reject-btn"]')).toBeNull();
    await act(async () => {
      setNativeValue(reference, 'https://example.feishu.cn/minutes/obcn-manual');
      reference.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ intake: { revision: 5 } }) });
    await act(async () => {
      (container.querySelector('[data-testid="meeting-manual-import"]') as HTMLButtonElement).click();
    });
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/meeting-intakes/intake-1/manual-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 3,
        reference: 'https://example.feishu.cn/minutes/obcn-manual',
      }),
    });
  });

  it('exposes typed retry and routes regrant to the in-product plugin auth action', async () => {
    const retryItem = {
      ...item,
      detail: {
        ...item.detail,
        revision: 4,
        judgmentState: 'confirmed',
        executionState: 'failed',
        healthState: 'degraded',
        repair: { code: 'transcript_not_ready', action: 'retry', observedAt: 2 },
      },
    };
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ intake: { revision: 6 } }) });
    await renderCard(retryItem);
    await act(async () => (container.querySelector('[data-testid="meeting-retry"]') as HTMLButtonElement).click());
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/meeting-intakes/intake-1/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 4 }),
    });

    const regrantItem = {
      ...retryItem,
      detail: {
        ...retryItem.detail,
        revision: 7,
        repair: { code: 'auth_required', action: 'regrant', observedAt: 3 },
      },
    };
    await renderCard(regrantItem);
    const regrant = container.querySelector<HTMLAnchorElement>('[data-testid="meeting-regrant"]');
    expect(regrant?.href).toContain('/settings?s=plugins');
    expect(regrant?.textContent).toContain('重新连接飞书');
    await act(async () =>
      (container.querySelector('[data-testid="meeting-regrant-retry"]') as HTMLButtonElement).click(),
    );
    expect(mockApiFetch).toHaveBeenLastCalledWith('/api/meeting-intakes/intake-1/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    });
    expect(container.textContent).not.toContain('lark-cli auth login');
    expect(mockFetchPending).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit no-write action available and only dismisses after confirmation', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ intake: { revision: 2, judgmentState: 'dismissed' } }),
    });
    await renderCard();

    const dismiss = buttonWithText('这次会议不写入');
    expect(dismiss).toBeDefined();
    await act(async () => dismiss?.click());
    expect(container.textContent).toContain('确认这次会议不写入吗？');

    await act(async () => buttonWithText('返回')?.click());
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(buttonWithText('这次会议不写入')).toBeDefined();

    await act(async () => buttonWithText('这次会议不写入')?.click());
    await act(async () => buttonWithText('确认不写入')?.click());

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/meeting-intakes/intake-1/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/threads')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/meeting-intakes/intake-1/confirm')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/meeting-intakes/intake-1/retry')).toBe(false);
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('keeps no-write available for a confirmed failed intake without requiring choices again', async () => {
    const repairItem = {
      ...item,
      detail: {
        ...item.detail,
        revision: 4,
        judgmentState: 'confirmed',
        executionState: 'failed',
        healthState: 'degraded',
        unresolved: [],
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Saved context',
          destinationHandle: 'host:private-thread:archive-0',
          outputs: ['minutes'],
        },
        repair: { code: 'route_unavailable', action: 'retry', observedAt: 2 },
      },
    };
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ intake: { revision: 5, judgmentState: 'dismissed' } }),
    });
    await renderCard(repairItem);

    expect(buttonWithText('这次会议不写入')).toBeDefined();
    await act(async () => buttonWithText('这次会议不写入')?.click());
    await act(async () => buttonWithText('确认不写入')?.click());

    expect(mockApiFetch).toHaveBeenCalledWith('/api/meeting-intakes/intake-1/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 4 }),
    });
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/threads/archive-0')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/meeting-intakes/intake-1/retry')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/meeting-intakes/intake-1/confirm')).toBe(false);
  });

  it('does not offer no-write after the intake has succeeded', async () => {
    await renderCard({
      ...item,
      detail: {
        ...item.detail,
        judgmentState: 'confirmed',
        executionState: 'succeeded',
        healthState: 'healthy',
        unresolved: [],
      },
    });

    expect(buttonWithText('这次会议不写入')).toBeUndefined();
  });
});
