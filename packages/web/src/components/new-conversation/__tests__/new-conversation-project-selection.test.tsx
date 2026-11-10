import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { NewConversationPage } from '../NewConversationPage';

const projectA = 'D:\\Projects\\A';
const runtime = 'D:\\Projects\\A\\runtime';
const projectB = 'D:\\Projects\\B';
const mocks = vi.hoisted(() => ({
  project: { projectPath: undefined as string | undefined, preferredCats: [], pinned: false },
  updateProject: vi.fn(),
  send: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openPublishedArtifact: vi.fn(), setWorkspaceMode: vi.fn() }),
}));
vi.mock('@/stores/sidebarProjectionStore', () => ({
  useSidebarProjectionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ rows: [] }),
}));
vi.mock('../RecentWorks', () => ({ RecentWorks: () => null }));
vi.mock('../SessionImportPanel', () => ({ SessionImportPanel: () => null }));
vi.mock('../../content-review/useArtifactLightbox', () => ({
  useArtifactLightbox: () => ({ error: null, lightbox: null, open: () => false }),
}));
vi.mock('../useNewConversationAdmission', () => ({
  useNewConversationAdmission: () => ({
    ready: true,
    intent: mocks.project,
    phase: 'idle',
    optionsLocked: false,
    updateProject: mocks.updateProject,
    updatePinned: vi.fn(),
    send: mocks.send,
  }),
}));
vi.mock('../../ChatInput', () => ({
  ChatInput: (props: { composerContext: ReactNode; sendBlocked: boolean; onSend: (text: string) => void }) => (
    <div>
      {props.composerContext}
      <button type="button" data-testid="send" disabled={props.sendBlocked} onClick={() => props.onSend('hello')}>
        Send
      </button>
    </div>
  ),
}));

function browse(path: string, projectRestriction?: 'runtime_read_only' | 'configuration_unknown') {
  return Response.json({
    current: path,
    parent: 'D:\\Projects',
    isWindows: true,
    projectRestriction,
    entries: [
      { name: 'runtime', path: runtime, isDirectory: true },
      { name: 'project-b', path: projectB, isDirectory: true },
    ],
  });
}

function deferredResponse() {
  let resolveResponse!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return { promise, resolve: resolveResponse };
}

describe('new conversation project selection through the real directory browser', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(async () => {
    writeShellLanguage('zh');
    mocks.project.projectPath = projectA;
    mocks.updateProject.mockReset().mockImplementation((path: string | undefined) => {
      mocks.project.projectPath = path;
    });
    mocks.send.mockReset();
    mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/projects/drives') return Response.json({ drives: [], isWindows: true });
      return browse(new URL(url, 'http://test').searchParams.get('path') ?? projectA);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <NewConversationPage
          onNavigate={vi.fn()}
          sidebarOpen={false}
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
        />,
      );
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function button(label: string) {
    const target = [...document.querySelectorAll('button')].find(
      (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
    );
    assert.ok(target, label);
    return target;
  }
  function element<T extends HTMLElement>(selector: string) {
    const target = document.querySelector<T>(selector);
    assert.ok(target, selector);
    return target;
  }
  async function click(target: HTMLElement) {
    await act(async () => target.click());
  }
  async function openBrowser() {
    await click(element<HTMLButtonElement>('[data-testid="new-conversation-project"]'));
    await click(button('浏览文件夹或输入路径'));
  }
  function sendButton() {
    return element<HTMLButtonElement>('[data-testid="send"]');
  }
  async function editPath(path: string) {
    const input = element<HTMLInputElement>('[placeholder="输入路径…"]');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      assert.ok(setValue);
      setValue.call(input, path);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it.each([
    'pending',
    'http-error',
    'network-error',
    'runtime_read_only',
    'configuration_unknown',
  ] as const)('clears the old project and blocks sending after %s, including after closing the picker', async (scenario) => {
    const pending = deferredResponse();
    await openBrowser();
    mocks.apiFetch.mockImplementation(() => {
      if (scenario === 'pending') return pending.promise;
      if (scenario === 'http-error') return Promise.resolve(Response.json({ error: 'Unavailable' }, { status: 500 }));
      if (scenario === 'network-error') return Promise.reject(new Error('offline'));
      return Promise.resolve(browse(runtime, scenario));
    });
    await click(button('runtime'));
    expect(sendButton().disabled).toBe(true);
    expect(mocks.project.projectPath).toBeUndefined();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(sendButton().disabled).toBe(true);
    await click(sendButton());
    expect(mocks.send).not.toHaveBeenCalled();
    await act(async () => pending.resolve(browse(runtime, 'runtime_read_only')));
  });

  it('requires an explicit choice of a verified ordinary directory after a failed request', async () => {
    await openBrowser();
    mocks.apiFetch.mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 500 }));
    await click(button('runtime'));
    await editPath(projectB);
    await click(button('前往路径'));
    expect(sendButton().disabled).toBe(true);
    await click(button('使用这个文件夹'));
    expect(mocks.project.projectPath).toBe(projectB);
    expect(sendButton().disabled).toBe(false);
    await click(sendButton());
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('blocks an edited path until the backend has verified it', async () => {
    await openBrowser();
    const requests = mocks.apiFetch.mock.calls.length;
    await editPath('D:\\Unverified');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(requests);
    expect(mocks.project.projectPath).toBeUndefined();
    expect(sendButton().disabled).toBe(true);
  });

  it('keeps virtual drive locations blocked and restores sending only on explicit lobby selection', async () => {
    await openBrowser();
    await click(element<HTMLButtonElement>('[title="查看所有磁盘"]'));
    expect(mocks.project.projectPath).toBeUndefined();
    expect(sendButton().disabled).toBe(true);
    await click(button('收起浏览'));
    expect(sendButton().disabled).toBe(true);
    await click(button('大厅（无项目）'));
    expect(sendButton().disabled).toBe(false);
    expect(mocks.project.projectPath).toBeUndefined();
  });

  it('ignores a late restricted response after a verified ordinary directory has been selected', async () => {
    const pending = deferredResponse();
    await openBrowser();
    mocks.apiFetch.mockReturnValueOnce(pending.promise);
    await click(button('runtime'));
    await editPath(projectB);
    await click(button('前往路径'));
    await click(button('使用这个文件夹'));
    await act(async () => pending.resolve(browse(runtime, 'runtime_read_only')));
    expect(mocks.project.projectPath).toBe(projectB);
    expect(sendButton().disabled).toBe(false);
  });
});
