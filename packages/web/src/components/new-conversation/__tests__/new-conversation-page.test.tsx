import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import type { FirstMessageAdmissionPhase } from '../first-message-admission';

const mocks = vi.hoisted(() => ({
  admission: {} as Record<string, unknown>,
  openPublishedArtifact: vi.fn(),
  setWorkspaceMode: vi.fn(),
  setCurrentThread: vi.fn(),
  closeRightPanel: vi.fn(),
  queueWorkDiscussion: vi.fn(),
  currentThreadId: 'default',
  fakeArtifact: {
    type: 'file',
    name: 'work.md',
    url: '/uploads/work.md',
    catId: 'codex-sol',
    createdAt: 1,
    sourceMessageId: 'message-1',
    threadId: 'thread-1',
    threadTitle: 'Thread',
  } as GlobalArtifactDTO,
}));

vi.mock('next/image', () => ({
  default: ({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean }) => (
    <span role="img" aria-label={alt} data-src={src} />
  ),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        openPublishedArtifact: mocks.openPublishedArtifact,
        setWorkspaceMode: mocks.setWorkspaceMode,
      }),
    {
      getState: () => ({
        currentThreadId: mocks.currentThreadId,
        openPublishedArtifact: mocks.openPublishedArtifact,
        setCurrentThread: mocks.setCurrentThread,
        closeRightPanel: mocks.closeRightPanel,
      }),
    },
  ),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [{ id: 'codex-sol', displayName: 'Sol', mentionPatterns: ['@codex-sol'] }] }),
}));

vi.mock('../queue-work-discussion', () => ({ queueWorkDiscussion: mocks.queueWorkDiscussion }));

vi.mock('@/stores/sidebarProjectionStore', () => ({
  useSidebarProjectionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ rows: [{ projectPath: '/work/cafe', lastActiveAt: 10 }] }),
}));

vi.mock('../useNewConversationAdmission', () => ({
  useNewConversationAdmission: () => mocks.admission,
}));

vi.mock('../../ChatInput', () => ({
  ChatInput: (props: {
    composerHeader?: React.ReactNode;
    composerContext?: React.ReactNode;
    onSend: (content: string, files?: File[]) => Promise<boolean>;
    prospectiveThread?: {
      preferredCats: readonly string[];
      onPreferredCatsChange: (ids: string[]) => void;
    };
  }) => (
    <div data-testid="composer">
      {props.composerHeader}
      {props.composerContext}
      <span data-testid="prospective-preferred">{props.prospectiveThread?.preferredCats.join(',')}</span>
      <button type="button" onClick={() => props.prospectiveThread?.onPreferredCatsChange(['codex-sol', 'opus55'])}>
        preferred in +
      </button>
      <button type="button" onClick={() => void props.onSend('first message', [new File(['a'], 'a.txt')])}>
        send first
      </button>
    </div>
  ),
}));

vi.mock('../NewConversationComposerContext', () => ({
  NewConversationComposerContext: (props: {
    projectPath?: string;
    existingProjects: string[];
    locked: boolean;
    pinned?: boolean;
    onProjectChange: (path: string) => void;
    onPinnedChange?: (pinned: boolean) => void;
  }) => (
    <div data-testid="composer-context" data-locked={String(props.locked)}>
      {props.projectPath}:{props.existingProjects.join(',')}
      <button type="button" onClick={() => props.onProjectChange('/work/next')}>
        project
      </button>
      <input
        data-testid="new-conversation-pin"
        type="checkbox"
        checked={props.pinned ?? false}
        disabled={props.locked}
        onChange={(event) => props.onPinnedChange?.(event.target.checked)}
      />
    </div>
  ),
}));

vi.mock('../RecentWorks', () => ({
  RecentWorks: ({
    onOpen,
    onOpenAll,
    onDiscuss,
  }: {
    onOpen: (artifact: GlobalArtifactDTO) => void;
    onOpenAll: () => void;
    onDiscuss: (artifact: GlobalArtifactDTO) => void;
  }) => (
    <div data-testid="works">
      <button type="button" onClick={() => onOpen(mocks.fakeArtifact)}>
        open work
      </button>
      <button type="button" onClick={onOpenAll}>
        all works
      </button>
      <button type="button" onClick={() => onDiscuss(mocks.fakeArtifact)}>
        discuss work
      </button>
    </div>
  ),
}));

import { landingArtworkForHour, NewConversationPage } from '../NewConversationPage';

function baseAdmission() {
  return {
    ready: true,
    loadFailed: false,
    localSaveFailed: false,
    intent: {
      v: 1 as const,
      createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
      projectPath: '/work/cafe',
      preferredCats: ['codex-sol'],
      title: '',
      pinned: false,
      creationStarted: false,
    },
    phase: 'idle' as FirstMessageAdmissionPhase,
    uploadStatus: 'idle' as const,
    uploadError: null,
    optionsLocked: false,
    updateTitle: vi.fn(),
    updatePinned: vi.fn(),
    updateProject: vi.fn(),
    updatePreferredCats: vi.fn(),
    onDraftChange: vi.fn(),
    send: vi.fn(async () => true),
    retryLoad: vi.fn(),
  };
}

describe('F322 new conversation page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    writeShellLanguage('zh');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.admission = baseAdmission();
    mocks.openPublishedArtifact.mockReset();
    mocks.setWorkspaceMode.mockReset();
    mocks.currentThreadId = 'default';
    mocks.setCurrentThread.mockReset().mockImplementation((threadId: string) => {
      mocks.currentThreadId = threadId;
    });
    mocks.closeRightPanel.mockReset();
    mocks.queueWorkDiscussion.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('switches between the accepted dusk and night art at the decided hours', () => {
    expect(landingArtworkForHour(5)).toBe('night');
    expect(landingArtworkForHour(6)).toBe('dusk');
    expect(landingArtworkForHour(21)).toBe('dusk');
    expect(landingArtworkForHour(22)).toBe('night');
  });

  it.each([
    'zh',
    'en',
  ] as const)('keeps %s collaboration and real setup independent of failed owner admission', (language) => {
    writeShellLanguage(language);
    const admission = baseAdmission();
    admission.ready = false;
    admission.loadFailed = true;
    mocks.admission = admission;
    const show = vi.fn();
    const navigate = vi.fn();
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={navigate}
          onShowCollaboration={show}
        />,
      ),
    );
    const watch = container.querySelector<HTMLButtonElement>('[data-testid="empty-state-bootcamp"]');
    expect(watch?.textContent).toBe(language === 'zh' ? '看看团队如何协作' : 'See the team collaborate');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/settings?s=members&view=setup');
    act(() => watch?.click());
    expect(show).toHaveBeenCalledOnce();
    expect(admission.send).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reveals the original conversation after restoring its saved workspace, without sending', () => {
    const navigate = vi.fn();
    let closedThread: string | undefined;
    mocks.closeRightPanel.mockImplementation(() => {
      closedThread = mocks.currentThreadId;
    });
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={navigate}
        />,
      ),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'discuss work')
        ?.click(),
    );
    expect(mocks.queueWorkDiscussion).toHaveBeenCalledWith(mocks.fakeArtifact, '@codex-sol ', expect.any(Object));
    expect(closedThread).toBe('thread-1');
    expect(navigate).toHaveBeenCalledWith('thread-1');
    expect(mocks.admission.send).not.toHaveBeenCalled();
  });

  it('keeps the current workspace and route when the original draft cannot admit the discussion', () => {
    mocks.queueWorkDiscussion.mockReturnValue(false);
    const navigate = vi.fn();
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={navigate}
        />,
      ),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'discuss work')
        ?.click(),
    );
    expect(mocks.setCurrentThread).not.toHaveBeenCalled();
    expect(mocks.closeRightPanel).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the composer as the sole creation action and routes real work actions through existing owners', async () => {
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('今天，想一起做点什么？');
    expect(container.querySelector('[data-testid="new-conversation-title-lead"]')?.className).toContain('max-sm:block');
    expect(container.querySelector('[data-testid="new-conversation-title-rest"]')?.textContent).toBe(
      '想一起做点什么？',
    );
    expect(container.querySelector('[data-testid="composer-context"]')?.textContent).toContain('/work/cafe');
    expect(container.querySelector('[data-testid="prospective-preferred"]')?.textContent).toBe('codex-sol');
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    act(() => buttons.find((button) => button.textContent === 'project')?.click());
    expect(mocks.admission.updateProject as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/work/next');
    act(() => buttons.find((button) => button.textContent === 'preferred in +')?.click());
    expect(mocks.admission.updatePreferredCats as ReturnType<typeof vi.fn>).toHaveBeenCalledWith([
      'codex-sol',
      'opus55',
    ]);
    await act(async () => buttons.find((button) => button.textContent === 'send first')?.click());
    expect(mocks.admission.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'first message', images: [expect.any(File)] }),
    );

    act(() => buttons.find((button) => button.textContent === 'open work')?.click());
    expect(mocks.openPublishedArtifact).toHaveBeenCalledWith('default', mocks.fakeArtifact, undefined);
    act(() => buttons.find((button) => button.textContent === 'all works')?.click());
    expect(mocks.setWorkspaceMode).toHaveBeenCalledWith('artifacts');
  });

  it('keeps optional naming and pinning inside the first-message composer and wires both to the pending intent', () => {
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    const title = container.querySelector<HTMLInputElement>('[data-testid="new-conversation-title"]');
    expect(title?.placeholder).toBe('对话名（可不填）');
    expect(title?.value).toBe('');
    expect(title?.className).toContain('max-sm:pr-14');
    act(() => {
      if (!title) throw new Error('missing conversation title input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(title, '季度研究计划');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(mocks.admission.updateTitle as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('季度研究计划');

    const pin = container.querySelector<HTMLInputElement>('[data-testid="new-conversation-pin"]');
    expect(pin?.checked).toBe(false);
    act(() => pin?.click());
    expect(mocks.admission.updatePinned as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(true);
  });

  it('localizes the optional name and locks creation options once the first send starts', () => {
    writeShellLanguage('en');
    const admission = baseAdmission();
    admission.optionsLocked = true;
    admission.intent.title = 'Research sprint';
    admission.intent.pinned = true;
    mocks.admission = admission;

    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    const title = container.querySelector<HTMLInputElement>('[data-testid="new-conversation-title"]');
    const pin = container.querySelector<HTMLInputElement>('[data-testid="new-conversation-pin"]');
    expect(title?.placeholder).toBe('Conversation name (optional)');
    expect(title?.value).toBe('Research sprint');
    expect(title?.disabled).toBe(true);
    expect(pin?.checked).toBe(true);
    expect(pin?.disabled).toBe(true);
  });

  it('does not mount the composer before owner recovery and offers a truthful retry', () => {
    const admission = baseAdmission();
    admission.ready = false;
    admission.loadFailed = true;
    admission.intent = null as never;
    mocks.admission = admission;
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(container.textContent).toContain('无法确认当前用户');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '重新连接')?.click());
    expect(admission.retryLoad).toHaveBeenCalledOnce();
  });

  it('does not claim the draft was saved when the recovery write itself failed', () => {
    const admission = baseAdmission();
    admission.localSaveFailed = true;
    admission.phase = 'create_failed';
    mocks.admission = admission;
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('本地持久保存失败');
    expect(container.textContent).not.toContain('草稿和选择都已保留');
  });

  it('asks for an explicit second send when another durable draft arrives during admission', () => {
    const admission = baseAdmission();
    admission.phase = 'draft_recovered';
    mocks.admission = admission;
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('已找回另一份未发送草稿');
    expect(container.textContent).toContain('再次发送即确认');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('explains that an incomplete attachment recovery blocked admission', () => {
    const admission = baseAdmission();
    admission.phase = 'draft_recovery_blocked';
    mocks.admission = admission;
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('附件尚未完整找回');
    expect(container.textContent).toContain('明确移除后再发送');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('translates the landing header actions with the rest of the English page', () => {
    writeShellLanguage('en');
    act(() =>
      root.render(
        <NewConversationPage
          sidebarOpen={false}
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={vi.fn()}
          onToggleStatusPanel={vi.fn()}
          onNavigate={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('What shall we make together today?');
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open Workspace"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="展开侧栏"]')).toBeNull();
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
