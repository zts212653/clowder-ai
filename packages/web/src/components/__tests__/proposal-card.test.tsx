/**
 * F128 ProposalCard frontend tests (AC-F6 / AC-F7 / AC-F8).
 *
 * Covers: render, edit-on-approve payload, reject, approved/rejected state flip,
 * the `cat-cafe:proposal-updated` CustomEvent → status sync,
 * pin-on-approve toggle (AC-F7), and auto-navigate to new thread (AC-F8).
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub MarkdownContent so we don't pull the markdown stack into the unit test.
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const navigateMock = vi.fn();
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: (...args: unknown[]) => navigateMock(...args),
}));

const chatStoreState = vi.hoisted(() => ({
  threads: [] as Array<{ id: string; projectPath?: string }>,
  updateThreadPin: vi.fn(),
}));
const pinMock = chatStoreState.updateThreadPin;
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (state: typeof chatStoreState) => unknown) => (selector ? selector(chatStoreState) : chatStoreState),
    {
      getState: () => chatStoreState,
    },
  ),
}));

import { ProposalCard } from '@/components/rich/ProposalCard';
import type { RichCardBlock } from '@/stores/chat-types';

const PROPOSAL_ID = 'proposal_test123';

function makeBlock(overrides: Partial<RichCardBlock> = {}): RichCardBlock {
  return {
    id: `proposal-${PROPOSAL_ID}`,
    kind: 'card',
    v: 1,
    title: `📥 提议新建 thread：F128 verification`,
    bodyMarkdown: 'Need a dedicated thread for review.',
    tone: 'info',
    fields: [
      { label: '父 Thread', value: 'thread_parent' },
      { label: '建议成员', value: 'codex, gemini' },
      { label: '首条消息', value: 'Kick off here.' },
    ],
    actions: [
      { label: '批准并创建', action: 'propose:approve', payload: { proposalId: PROPOSAL_ID } },
      { label: '驳回', action: 'propose:reject', payload: { proposalId: PROPOSAL_ID } },
    ],
    ...overrides,
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('ProposalCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetchMock.mockReset();
    navigateMock.mockReset();
    pinMock.mockReset();
    // First mount-time GET /api/proposals/:id → 404 by default so each test starts in pending state.
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(404, { error: 'not found' })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(block: RichCardBlock = makeBlock()) {
    await act(async () => {
      root.render(React.createElement(ProposalCard, { block }));
    });
  }

  function findButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
    if (!button) throw new Error(`Missing button: ${label}`);
    return button as HTMLButtonElement;
  }

  function readRequestBody(call: unknown[] | undefined): Record<string, unknown> {
    if (!call) throw new Error('Missing request call');
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('renders title, body, prefilled fields, and pending action buttons', async () => {
    await render();
    expect(container.textContent).toContain('提议新建 thread：F128 verification');
    expect(container.textContent).toContain('Need a dedicated thread for review.');
    expect(container.textContent).toContain('thread_parent');
    expect(container.textContent).toContain('codex, gemini');
    expect(container.textContent).toContain('Kick off here.');
    // Pending state shows 3 action buttons
    const buttonLabels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttonLabels).toContain('批准并创建');
    expect(buttonLabels).toContain('编辑');
    expect(buttonLabels).toContain('驳回');
  });

  it('approve POSTs to /api/proposals/:id/approve and flips card to approved state', async () => {
    await render();
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_new', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Wait microtasks for fetch promise resolution
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/proposals/${PROPOSAL_ID}/approve`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已批准');
    expect(container.textContent).toContain('thread_new');
  });

  it('reject POSTs to /api/proposals/:id/reject and flips card to rejected state', async () => {
    await render();
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, status: 'rejected' })),
    );
    await act(async () => {
      findButton('驳回').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/proposals/${PROPOSAL_ID}/reject`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已驳回');
  });

  it('edit mode sends user overrides in approve payload', async () => {
    await render();
    await act(async () => {
      findButton('编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Mutate the title input. React listens to onChange synthetic events that fire on the
    // native `input` event, but it tracks the previous value via a hidden property — assigning
    // `.value = ...` directly bypasses that tracking and React skips the update. We use the
    // native setter so React's change-tracker sees the new value.
    const titleInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      nativeSetter?.call(titleInput, 'edited title');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_edited', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准（含编辑）').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The last call must include the edited title in its JSON body
    const approveCall = apiFetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'));
    const sentBody = readRequestBody(approveCall);
    expect(sentBody.title).toBe('edited title');
  });

  it('cat-cafe:proposal-updated CustomEvent flips status without refetching', async () => {
    await render();
    expect(container.textContent).not.toContain('已批准');
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: { proposalId: PROPOSAL_ID, status: 'approved', createdThreadId: 'thread_socket' },
        }),
      );
    });
    expect(container.textContent).toContain('已批准');
    expect(container.textContent).toContain('thread_socket');
  });

  // AC-F7: pin-on-approve toggle
  it('renders a pin toggle checkbox in pending state', async () => {
    await render();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(container.textContent).toContain('置顶');
    // Default unchecked
    expect(checkbox.checked).toBe(false);
  });

  it('does NOT send pinned in approve body (pin is a separate PATCH)', async () => {
    await render();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_pinned', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const approveCall = apiFetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'));
    const sentBody = readRequestBody(approveCall);
    expect(sentBody.pinned).toBeUndefined();
  });

  it('does not call PATCH pin when pin toggle is unchecked', async () => {
    await render();
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_nopin', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const patchCall = apiFetchMock.mock.calls.find(
      ([url]) => String(url).includes('/api/threads/') && String(url).includes('thread_nopin'),
    );
    expect(patchCall).toBeUndefined();
  });

  it('PATCHes /api/threads/:id with pinned:true after approve when pin is checked', async () => {
    await render();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_pin_patch', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const patchCall = apiFetchMock.mock.calls.find(
      ([url, opts]) =>
        String(url) === '/api/threads/thread_pin_patch' && (opts as { method?: string })?.method === 'PATCH',
    );
    const patchBody = readRequestBody(patchCall);
    expect(patchBody.pinned).toBe(true);
    // P2 fix: local store must also be updated for immediate sidebar UX
    expect(pinMock).toHaveBeenCalledWith('thread_pin_patch', true);
  });

  it('does NOT call updateThreadPin when PATCH pin returns non-2xx', async () => {
    await render();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    // First call: approve → 200; Second call: PATCH pin → 500
    let callCount = 0;
    apiFetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_pin_fail', status: 'approved' }),
        );
      }
      return Promise.resolve(jsonResponse(500, { error: 'internal error' }));
    });
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pinMock).not.toHaveBeenCalled();
  });

  // AC-F8: auto-navigate to new thread after approve
  it('navigates to the new thread after successful approve', async () => {
    await render();
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_nav', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(navigateMock).toHaveBeenCalledWith('thread_nav', window);
  });

  it('shows clickable thread link in approved state', async () => {
    await render();
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_link', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准并创建').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const link = container.querySelector('[data-testid="thread-link"]') as HTMLElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toContain('thread_link');
  });
});
