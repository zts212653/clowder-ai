import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchPending = vi.fn(async () => {});
const mockApiFetch = vi.fn();

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ fetchPending: mockFetchPending }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      threads: [
        { id: 'thread-1', title: 'F292 产品讨论', createdBy: 'owner-1', participants: ['codex-sol'] },
        { id: 'system-1', title: '系统', createdBy: 'system', participants: [] },
      ],
    }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import { MeetingIntakeCard } from '../MeetingIntakeCard';

function setNativeValue(element: HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
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

    const speaker = container.querySelector('[data-testid="meeting-speakers"]') as HTMLTextAreaElement;
    const context = container.querySelector('[data-testid="meeting-context"]') as HTMLTextAreaElement;
    const destination = container.querySelector('[data-testid="meeting-destination"]') as HTMLSelectElement;
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
      setNativeValue(destination, 'host:private-thread:thread-1');
      destination.dispatchEvent(new Event('change', { bubbles: true }));
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

  it('exposes typed retry and regrant repairs and refreshes the exact item after each action', async () => {
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
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ intake: { revision: 6 } }) });
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
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ regrant: { argv: ['lark-cli', 'auth', 'login', '--as', 'user'] } }),
    });
    await act(async () => root.render(React.createElement(MeetingIntakeCard, { item: regrantItem })));
    await act(async () => (container.querySelector('[data-testid="meeting-regrant"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain('lark-cli auth login --as user');
    expect(mockFetchPending).toHaveBeenCalledTimes(2);
  });
});
