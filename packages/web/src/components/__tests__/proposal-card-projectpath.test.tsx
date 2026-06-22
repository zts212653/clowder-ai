/**
 * F128 ProposalCard — projectPath ownership (砚砚 review P1-1).
 *
 * The backend card block surfaces a 项目归属 field and the approve route accepts a projectPath
 * override, but neither is usable unless the card renders the field + submits the input. These
 * tests pin: (1) the ownership is visible, (2) editing + approve sends projectPath, (3) the
 * default-notice string is NOT prefilled into the editable input (only a real path is).
 *
 * Split from proposal-card.test.tsx to keep each file under the AC-X1 350-line cap.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
}));

const chatStoreState = vi.hoisted(() => ({
  threads: [] as Array<{ id: string; projectPath?: string }>,
  updateThreadPin: vi.fn(),
}));

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

const PROPOSAL_ID = 'proposal_pp123';
const DEFAULT_NOTICE = '未指定（default · 子 thread 无项目归属，cat 会回落运行时默认目录）';

function makeBlock(ownership: string, reportingMode = 'final-only（默认 · 完成时回报一次）'): RichCardBlock {
  return {
    id: `proposal-${PROPOSAL_ID}`,
    kind: 'card',
    v: 1,
    title: `📥 提议新建 thread：projectPath`,
    bodyMarkdown: 'body',
    tone: 'info',
    fields: [
      { label: '父 Thread', value: 'thread_parent' },
      { label: '建议成员', value: '（未指定）' },
      { label: '回报模式', value: reportingMode },
      { label: '项目归属', value: ownership },
    ],
    actions: [
      { label: '批准并创建', action: 'propose:approve', payload: { proposalId: PROPOSAL_ID } },
      { label: '驳回', action: 'propose:reject', payload: { proposalId: PROPOSAL_ID } },
    ],
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('ProposalCard — projectPath ownership', () => {
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
    chatStoreState.threads = [
      { id: 'thread_cat_cafe', projectPath: '/home/user/cat-cafe' },
      { id: 'thread_clowder', projectPath: '/home/user/projects/clowder-ai' },
      { id: 'thread_default', projectPath: 'default' },
    ];
    chatStoreState.updateThreadPin.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(404, { error: 'not found' })));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(block: RichCardBlock) {
    await act(async () => {
      root.render(React.createElement(ProposalCard, { block }));
    });
  }

  function findButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((n) => n.textContent?.includes(label));
    if (!button) throw new Error(`Missing button: ${label}`);
    return button as HTMLButtonElement;
  }

  // Find the text input whose enclosing <label> mentions the given field name.
  function findInputByLabel(labelText: string): HTMLInputElement {
    const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(labelText));
    const input = label?.querySelector('input[type="text"]') as HTMLInputElement | null;
    if (!input) throw new Error(`Missing input for label: ${labelText}`);
    return input;
  }

  function findSelectByLabel(labelText: string): HTMLSelectElement {
    const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(labelText));
    const select = label?.querySelector('select') as HTMLSelectElement | null;
    if (!select) throw new Error(`Missing select for label: ${labelText}`);
    return select;
  }

  function setInput(input: HTMLInputElement, value: string) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function readApproveBody(): Record<string, unknown> {
    const approveCall = apiFetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'));
    if (!approveCall) throw new Error('Missing approve call');
    return JSON.parse((approveCall[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('surfaces the project ownership in the card (AC-Z4 visibility)', async () => {
    await render(makeBlock('/home/user/projects/clowder-ai'));
    expect(container.textContent).toContain('回报模式');
    expect(container.textContent).toContain('final-only');
    expect(container.textContent).toContain('项目归属');
    expect(container.textContent).toContain('/home/user/projects/clowder-ai');
  });

  it('shows the default-ownership notice when the child has no project', async () => {
    await render(makeBlock(DEFAULT_NOTICE));
    expect(container.textContent).toContain(DEFAULT_NOTICE);
    expect(container.textContent).toContain('会进入未分类');
    expect(findButton('批准并创建').textContent).toContain('保留未分类');
  });

  it('edit + approve sends the projectPath override in the approve body (AC-Z2 re-home)', async () => {
    await render(makeBlock(DEFAULT_NOTICE));
    await act(async () => {
      findButton('编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Default notice must NOT be prefilled into the editable input — only a real path is.
    const ppInput = findInputByLabel('项目归属');
    expect(ppInput.value).toBe('');
    await act(async () => {
      setInput(ppInput, '/home/user/projects/clowder-ai');
    });
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_rehomed', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准（含编辑）').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const sentBody = readApproveBody();
    expect(sentBody.projectPath).toBe('/home/user/projects/clowder-ai');
  });

  it('edit + approve lets the user override reportingMode to autonomous', async () => {
    await render(makeBlock('/home/user/cat-cafe'));
    await act(async () => {
      findButton('编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const select = findSelectByLabel('回报模式');
    expect(select.value).toBe('final-only');
    await act(async () => {
      select.value = 'none';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    apiFetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_autonomous', status: 'approved' }),
      ),
    );
    await act(async () => {
      findButton('批准（含编辑）').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sentBody = readApproveBody();
    expect(sentBody.reportingMode).toBe('none');
    expect(container.textContent).toContain('autonomous（下游自治，无强制回报）');
    expect(container.textContent).not.toContain('final-only（默认 · 完成时回报一次）');
  });

  it('edit mode offers an existing-project picker for default-owned proposals (AC-AB2)', async () => {
    await render(makeBlock(DEFAULT_NOTICE));
    await act(async () => {
      findButton('编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('点“编辑”选择项目');
    expect(container.textContent).toContain('请选择项目，或留空表示明确保留未分类');

    const select = findSelectByLabel('从已有项目选择');
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      '/home/user/cat-cafe',
      '/home/user/projects/clowder-ai',
    ]);

    await act(async () => {
      select.value = '/home/user/cat-cafe';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(findInputByLabel('项目归属').value).toBe('/home/user/cat-cafe');
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { proposalId: PROPOSAL_ID, threadId: 'thread_rehomed', status: 'approved' })),
    );
    await act(async () => {
      findButton('批准（含编辑）').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sentBody = readApproveBody();
    expect(sentBody.projectPath).toBe('/home/user/cat-cafe');
  });

  it('refreshes the existing-project picker when threads load after first render (cloud P2)', async () => {
    chatStoreState.threads = [];
    const block = makeBlock(DEFAULT_NOTICE);
    await render(block);
    await act(async () => {
      findButton('编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('从已有项目选择');

    chatStoreState.threads = [{ id: 'thread_cat_cafe', projectPath: '/home/user/cat-cafe' }];
    await render(block);

    expect([...findSelectByLabel('从已有项目选择').options].map((option) => option.value)).toEqual([
      '',
      '/home/user/cat-cafe',
    ]);
  });

  it('prefills a real project path into the editable input', async () => {
    await render(makeBlock('/home/user/projects/repo'));
    await act(async () => {
      findButton('编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(findInputByLabel('项目归属').value).toBe('/home/user/projects/repo');
  });

  it('uses finalized reportingMode from proposal GET after reload (cloud P2)', async () => {
    apiFetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          proposal: {
            proposalId: PROPOSAL_ID,
            status: 'approved',
            createdThreadId: 'thread_autonomous',
            reportingMode: 'none',
          },
        }),
      ),
    );

    await render(makeBlock('/home/user/cat-cafe', 'final-only（默认 · 完成时回报一次）'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('autonomous（下游自治，无强制回报）');
    expect(container.textContent).not.toContain('final-only（默认 · 完成时回报一次）');
  });

  it('uses finalized reportingMode from proposal socket updates (cloud P2)', async () => {
    await render(makeBlock('/home/user/cat-cafe', 'final-only（默认 · 完成时回报一次）'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: {
            proposalId: PROPOSAL_ID,
            status: 'approved',
            createdThreadId: 'thread_socket_autonomous',
            reportingMode: 'none',
          },
        }),
      );
    });

    expect(container.textContent).toContain('autonomous（下游自治，无强制回报）');
    expect(container.textContent).not.toContain('final-only（默认 · 完成时回报一次）');
  });
});
