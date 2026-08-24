import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { MeetingIntakeCard } from '../MeetingIntakeCard';

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

  it('collects speakers, context, existing private thread, and outputs before exact-revision confirm', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ intake: { revision: 4 } }) });
    await act(async () => root.render(React.createElement(MeetingIntakeCard, { item })));

    expect(container.textContent).toContain('Needs Me');
    expect(container.textContent).toContain('Weekly sync');
    expect(container.textContent).not.toContain('系统');
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

  it('creates a private Thread in place and selects it without navigating away from the approval card', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'thread-created',
        title: 'Weekly sync 跟进',
        projectPath: '/workspace/cat-cafe',
        createdBy: 'owner-1',
        participants: [],
        lastActiveAt: 400,
        createdAt: 400,
      }),
    });
    await act(async () => root.render(React.createElement(MeetingIntakeCard, { item })));

    expect(container.querySelector('select[data-testid="meeting-destination"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="meeting-destination-create-toggle"]') as HTMLButtonElement).click();
    });
    const title = container.querySelector('[data-testid="meeting-destination-create-title"]') as HTMLInputElement;
    expect(title.value).toContain('Weekly sync');
    await act(async () => {
      setNativeValue(title, 'Weekly sync 跟进');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="meeting-destination-create-confirm"]') as HTMLButtonElement).click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Weekly sync 跟进', projectPath: '/workspace/cat-cafe' }),
    });
    expect(container.textContent).toContain('已选择：Weekly sync 跟进');
    expect(mockInvalidateSidebarProjection).toHaveBeenCalledTimes(1);
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
    await act(async () => root.render(React.createElement(MeetingIntakeCard, { item: repairItem })));
    expect(container.querySelector('[data-testid="meeting-manual-transcript"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="reject-btn"]')).toBeNull();
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
    await act(async () => root.render(React.createElement(MeetingIntakeCard, { item: retryItem })));
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
    await act(async () => root.render(React.createElement(MeetingIntakeCard, { item: regrantItem })));
    const regrant = container.querySelector<HTMLAnchorElement>('[data-testid="meeting-regrant"]');
    expect(regrant?.href).toContain('/settings?s=plugins');
    expect(regrant?.textContent).toContain('去插件设置连接飞书');
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
});
