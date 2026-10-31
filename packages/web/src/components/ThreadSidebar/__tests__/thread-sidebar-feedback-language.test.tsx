import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import type { NewThreadOptions } from '../DirectoryPickerModal';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
import {
  addToastMock,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  openCreateDialog,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
  textFail,
} from './thread-sidebar-test-helpers';

const dialog = vi.hoisted(() => ({ options: { title: 'Exact submitted title' } as NewThreadOptions }));
// Only the picker adapter is simplified. The real Sidebar owns POST, bind, reconcile and feedback.
vi.mock('../DirectoryPickerModal', () => ({
  DirectoryPickerModal: ({ onSelect }: { onSelect: (options: NewThreadOptions) => void }) => (
    <button type="button" data-testid="confirm-project" onClick={() => onSelect(dialog.options)}>
      Confirm
    </button>
  ),
}));

describe('boot20 Sidebar production feedback and accessible language', () => {
  let harness: ThreadSidebarHarness;
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    dialog.options = { title: 'Exact submitted title' };
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    writeShellLanguage('zh');
    writeShellPresentation('classic');
    vi.restoreAllMocks();
    resetThreadSidebarGlobals();
  });
  async function openPendingPicker() {
    writeShellPresentation('classic');
    await harness.render();
    await openCreateDialog(harness.container, harness.flush);
    // The existing picker survives classic → v2. Test the actual shared create callback, not Header props.
    act(() => {
      writeShellPresentation('v2');
      writeShellLanguage('en');
    });
  }
  async function submit() {
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="confirm-project"]')?.click(),
    );
    await harness.flush();
  }
  it('localizes the production Group wrapper and keeps classic accessible names frozen', async () => {
    mockStore.threads = ['member', 'member-2'].map((id) => ({
      id,
      title: id,
      projectPath: '/project',
      participants: [],
      createdBy: 'user',
      createdAt: 1,
      lastActiveAt: 1,
      pinned: true,
      presence: { status: 'idle' },
    }));
    mockApiFetch.mockImplementation((path: string) =>
      path === '/api/config/thread-attention'
        ? jsonOk({ aliases: {}, open: {}, groups: [{ id: 'g', name: 'Our group', threadIds: ['member', 'member-2'] }] })
        : defaultSidebarApiMock(path),
    );
    writeShellPresentation('v2');
    writeShellLanguage('en');
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
    await harness.render();
    const group = () => harness.container.querySelector('[role="group"][data-attention-drop-group="group:g"]');
    expect(group(), 'the actual Sidebar Group wrapper').not.toBeNull();
    expect(group()?.getAttribute('aria-label')).toBe('Conversation group: Our group');
    act(() => writeShellLanguage('zh'));
    expect(group()?.getAttribute('aria-label')).toBe('对话组：Our group');
    act(() => {
      writeShellLanguage('en');
      writeShellPresentation('classic');
    });
    expect(group()?.getAttribute('aria-label')).toBe('对话组：Our group');
  });
  it.each([
    'rejected',
    'invalid-id',
    'exception',
    'unconfirmed',
    'confirmed',
  ] as const)('localizes actual %s creation feedback without repeating the POST', async (scenario) => {
    await openPendingPicker();
    const created = {
      id: 'new-thread',
      title: dialog.options.title,
      projectPath: 'default',
      participants: [],
      createdBy: 'user',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pinned: false,
      presence: { status: 'idle' },
    };
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') {
        if (scenario === 'rejected') return textFail(500);
        if (scenario === 'invalid-id') return jsonOk({});
        return Promise.reject(
          Object.assign(new Error('request failed'), {
            name: ['confirmed', 'unconfirmed'].includes(scenario) ? 'TimeoutError' : 'Error',
          }),
        );
      }
      if (path === '/api/threads?view=sidebar') return jsonOk({ threads: scenario === 'confirmed' ? [created] : [] });
      return defaultSidebarApiMock(path);
    });
    await submit();
    const expected = {
      rejected: ['Could not create conversation', 'This conversation was not created. Please try again later.'],
      'invalid-id': [
        'Could not create conversation',
        'The server did not return a valid conversation ID. Please try again later.',
      ],
      exception: ['Could not create conversation', 'The create request did not complete. Please try again later.'],
      unconfirmed: [
        'Creation not confirmed',
        'The request timed out. We checked the server but could not confirm creation. We did not retry automatically; please check the sidebar first.',
      ],
      confirmed: [
        'Creation confirmed',
        'The request timed out, but the server confirmed creation. We did not submit it twice.',
      ],
    }[scenario];
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: expected[0], message: expected[1] }));
    expect(
      mockApiFetch.mock.calls.filter(([path, init]) => path === '/api/threads' && init?.method === 'POST'),
    ).toHaveLength(1);
    // Same actual producer in classic retains original Chinese feedback.
    act(() => writeShellPresentation('classic'));
    await openCreateDialog(harness.container, harness.flush);
    await submit();
    expect(addToastMock.mock.calls.at(-1)?.[0].title).toBe(
      scenario === 'confirmed' ? '创建结果未确认' : scenario === 'unconfirmed' ? '创建结果未确认' : '创建线程失败',
    );
  });
  it('renders partial binding facts in the current language and keeps the warning across presentation changes', async () => {
    dialog.options.sessionBindings = [
      { catId: 'sol', cliSessionId: 'external-1' },
      { catId: 'astra', cliSessionId: 'external-2' },
    ];
    await openPendingPicker();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk({ id: 'new-thread' });
      if (path.endsWith('/sessions/sol/bind')) return textFail(500);
      if (path.endsWith('/sessions/astra/bind')) return jsonOk({});
      return defaultSidebarApiMock(path);
    });
    await submit();
    expect(harness.container.querySelector('[data-testid="sidebar-v2-header"]')?.textContent).toContain(
      'Some Session bindings failed (1/2). Retry in the Session panel.',
    );
    act(() => writeShellLanguage('zh'));
    expect(harness.container.textContent).toContain('Session 绑定部分失败（1/2），可在 Session 面板重试');
    act(() => {
      writeShellLanguage('en');
      writeShellPresentation('classic');
    });
    expect(harness.container.textContent).toContain('Session 绑定部分失败（1/2），可在 Session 面板重试');
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2);
  });
  it.each([
    'v2',
    'classic',
  ] as const)('uses the current %s language when a pending create finally returns', async (presentation) => {
    let fail: (() => void) | undefined;
    await openPendingPicker();
    act(() => writeShellLanguage('zh'));
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) =>
      path === '/api/threads' && init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            fail = () => resolve(new Response('', { status: 500 }));
          })
        : defaultSidebarApiMock(path),
    );
    await submit();
    act(() => {
      writeShellLanguage('en');
      writeShellPresentation(presentation);
    });
    await act(async () => fail?.());
    await harness.flush();
    expect(addToastMock.mock.calls.at(-1)?.[0].title).toBe(
      presentation === 'v2' ? 'Could not create conversation' : '创建线程失败',
    );
  });
});
