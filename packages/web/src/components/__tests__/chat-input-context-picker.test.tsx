import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useChatStore } from '@/stores/chatStore';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/components/icons/SendIcon', () => ({ SendIcon: () => React.createElement('span', null, 'send') }));
vi.mock('@/components/icons/LoadingIcon', () => ({ LoadingIcon: () => React.createElement('span', null, 'loading') }));
vi.mock('@/components/icons/AttachIcon', () => ({ AttachIcon: () => React.createElement('span', null, 'attach') }));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/components/AttachmentPreview', () => ({ AttachmentPreview: () => null }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: apiFetchMock }));

let container: HTMLDivElement;
let root: Root;
let threadSequence = 0;
let onSendMock: React.ComponentProps<typeof ChatInput>['onSend'];

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ results: [{ path: 'docs/features/F063-hub-workspace-explorer.md' }] }),
  });
  const currentThreadId = `thread_current_${threadSequence++}`;
  onSendMock = vi.fn();
  useChatStore.setState({
    currentThreadId,
    threads: [
      {
        id: 'default',
        projectPath: '/repo',
        title: '大厅',
        createdBy: 'default-user',
        participants: [],
        lastActiveAt: 30,
        createdAt: 5,
      },
      {
        id: 'thread_other',
        projectPath: '/repo',
        title: '另一个 Thread',
        createdBy: 'default-user',
        participants: [],
        lastActiveAt: 20,
        createdAt: 10,
      },
    ],
    workspaceOpenFilePath: 'docs/current.md',
    workspaceWorktreeId: 'wt-main',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ChatInput threadId={currentThreadId} onSend={onSendMock} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ChatInput context picker', () => {
  function openContextPicker() {
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="添加"]');
    expect(addButton).not.toBeNull();

    act(() => addButton?.click());
    const contextAction = container.querySelector<HTMLButtonElement>('[data-testid="composer-add-context"]');
    expect(contextAction).not.toBeNull();
    act(() => contextAction?.click());
  }

  it('keeps one stable add entry and discloses secondary actions on demand', () => {
    expect(container.querySelector('button[aria-label="添加"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Attach images"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Whisper mode"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Game mode"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click());

    const menu = container.querySelector('[data-testid="composer-add-menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('引用 Thread 或文件');
    expect(menu?.textContent).toContain('上传附件');
    expect(menu?.textContent).toContain('悄悄话');
    expect(menu?.textContent).toContain('游戏');
  });

  it('opens context from the unified add menu and adds a selected thread attachment', () => {
    openContextPicker();

    const thread = container.querySelector<HTMLButtonElement>('[data-testid="context-thread-thread_other"]');
    expect(thread?.textContent).toContain('另一个 Thread');
    expect(container.querySelector('[data-testid="context-thread-default"]')).toBeNull();

    act(() => thread?.click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector('[data-context-kind="thread"]')?.textContent).toContain('另一个 Thread');

    act(() => {
      container
        .querySelector<HTMLTextAreaElement>('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSendMock).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined, undefined, [
      expect.objectContaining({ kind: 'thread', threadId: 'thread_other', title: '另一个 Thread' }),
    ]);
  });

  it('opens the thread picker from /thread without changing @ mention semantics', () => {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('textarea missing');

    act(() => typeInto(textarea, '/thread'));
    expect(container.querySelector('[data-testid="chat-context-picker"]')).not.toBeNull();

    const thread = container.querySelector<HTMLButtonElement>('[data-testid="context-thread-thread_other"]');
    act(() => thread?.click());
    expect(textarea.value).toBe('');
    expect(container.querySelector('[data-context-kind="thread"]')).not.toBeNull();
  });

  it('adds the current Workspace file with its worktree identity', () => {
    openContextPicker();

    const file = container.querySelector<HTMLButtonElement>('[data-testid="context-file-docs/current.md"]');
    expect(file?.textContent).toContain('docs/current.md');
    act(() => file?.click());

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector('[data-context-kind="workspace_file"]')?.textContent).toContain('docs/current.md');
  });

  it('searches Workspace filenames and inserts the selected result', async () => {
    openContextPicker();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索可添加的上下文"]');
    if (!search) throw new Error('context search missing');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'F063');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/workspace/search',
      expect.objectContaining({
        body: JSON.stringify({ worktreeId: 'wt-main', query: 'F063', type: 'filename', limit: 8 }),
      }),
    );
    const file = container.querySelector<HTMLButtonElement>(
      '[data-testid="context-file-docs/features/F063-hub-workspace-explorer.md"]',
    );
    act(() => file?.click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector('[data-context-kind="workspace_file"]')?.textContent).toContain(
      'docs/features/F063-hub-workspace-explorer.md',
    );
  });
});
