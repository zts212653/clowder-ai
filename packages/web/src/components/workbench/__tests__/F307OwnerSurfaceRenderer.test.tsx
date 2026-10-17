import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactListOrigin } from '@/components/artifacts/artifact-list-state';
import { MAILBOX_NAVIGATE_EVENT } from '@/components/shell/mailbox/mailbox-navigation';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { fileReturnLabel } from '@/components/workspace/V2WorkspaceFileChrome';
import { createCapabilityEvolutionWorkspaceSurface } from '../capability-evolution-workspace-adapter';
import {
  createApprovalActionSurface,
  createBrowserSurface,
  createContentEditorSurface,
  createEvolutionProgramSurface,
  createWorkspaceDestinationSurface,
  createWorkspaceModeSurface,
  resolveFileTarget,
  resolvePullRequestChangesTarget,
} from '../real-surface-adapters';

const listPr = vi.hoisted(() => ({
  origin: {
    kind: 'artifact-list',
    threadId: 'thread-a',
    view: { scope: 'thread', filter: 'all', query: '', grouping: 'none', catFilter: null, collapsed: [] },
  } as ArtifactListOrigin,
  artifact: {
    type: 'pr',
    name: 'Exact list PR',
    ref: 'Owner/Repo#7',
    catId: null,
    createdAt: 1,
    sourceMessageId: null,
  } as ThreadArtifactDTO,
}));
vi.mock('@/components/ArtifactsPanel', () => ({
  ArtifactsPanel: ({
    onSelectArtifact,
  }: {
    onSelectArtifact: (artifact: ThreadArtifactDTO, origin: ArtifactListOrigin) => void;
  }) => (
    <button type="button" data-testid="select-list-pr" onClick={() => onSelectArtifact(listPr.artifact, listPr.origin)}>
      List PR
    </button>
  ),
}));

vi.mock('@/components/workspace/BrowserPanel', () => ({
  BrowserPanel: ({ previewOnly }: { previewOnly?: boolean }) => (
    <div data-testid="browser-owner" data-preview-only={String(!!previewOnly)} />
  ),
}));

vi.mock('../content-editor/ContentEditorOwnerSurface', () => ({
  ContentEditorOwnerSurface: ({ target }: { target: { contentRef: string; sessionRef: string } }) => (
    <div data-testid="content-editor-owner" data-content-ref={target.contentRef} data-session-ref={target.sessionRef} />
  ),
}));

const ARTIFACT_COORDINATE = {
  artifactRef: 'artifact:ppt:tomorrows-ppt',
  artifactRevision: '7',
  completenessRef: 'artifact:ppt:tomorrows-ppt#available:7',
  previewRef: 'artifact:ppt:tomorrows-ppt#preview:7',
  openInWorkspaceRef: 'workspace:artifact:thread-f310:7:artifact:ppt:tomorrows-ppt',
};

vi.mock('@/components/workspace/ChangesPanel', () => ({
  ChangesPanel: ({
    worktreeId,
    threadId,
    onOpenFile,
  }: {
    worktreeId: string | null;
    threadId?: string | null;
    onOpenFile?: (path: string) => void;
  }) => (
    <div data-testid="changes-owner" data-worktree-id={worktreeId} data-thread-id={threadId}>
      <button type="button" data-testid="changes-open-file" onClick={() => onOpenFile?.('src/owner.ts')}>
        打开文件
      </button>
    </div>
  ),
}));

vi.mock('@/components/capability-evolution/CapabilityEvolutionWorkspace', () => ({
  CapabilityEvolutionWorkspace: ({
    targetThreadId,
    onOpenProgram,
  }: {
    targetThreadId: string | null;
    onOpenProgram: (programId: string) => void;
  }) => (
    <button
      type="button"
      data-testid="open-program-lifecycle"
      data-target-thread-id={targetThreadId ?? 'none'}
      onClick={() => onOpenProgram('evolution-program:bcc336788a7df9d6075b1efb4c0a7e68')}
    >
      能力进化 Workspace
    </button>
  ),
}));

const artifactFixture = vi.hoisted(() => ({ revision: 7, threadId: 'thread-f310' }));
vi.mock('@/utils/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api-client')>();
  return {
    ...actual,
    apiFetch: (path: string, ...args: Parameters<typeof actual.apiFetch> extends [string, ...infer R] ? R : never) =>
      path === '/api/threads/thread-f310/artifacts'
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                threadId: artifactFixture.threadId,
                artifacts: [
                  {
                    type: 'file',
                    name: 'Tomorrow presentation',
                    catId: 'codex-sol',
                    createdAt: artifactFixture.revision,
                    sourceMessageId: 'published',
                    url: 'artifact:ppt:tomorrows-ppt',
                  },
                ],
              }),
            ),
          )
        : actual.apiFetch(path, ...args),
  };
});

vi.mock('@/components/growing/ProductSchedulePanel', () => ({
  ProductSchedulePanel: ({
    onOpenArtifact,
  }: {
    onOpenArtifact: (artifact: typeof ARTIFACT_COORDINATE, itemRef: string) => void;
  }) => (
    <button
      type="button"
      data-testid="schedule-open-owner-artifact"
      onClick={() => onOpenArtifact(ARTIFACT_COORDINATE, 'task:work:ppt|4')}
    >
      open
    </button>
  ),
}));

vi.mock('@/components/growing/NeedsMePanel', () => ({
  NeedsMePanel: ({ onOpenAction }: { onOpenAction: (actionRef: string, itemRef: string) => void }) => (
    <>
      <button
        type="button"
        data-testid="needs-me-open-inline-approval"
        onClick={() => onOpenAction('/api/proposals/proposal%2Fone', 'task:work:ppt|4|f246.approval|proposal/one|7')}
      >
        approval
      </button>
      <button
        type="button"
        data-testid="needs-me-open-meeting-repair"
        onClick={() =>
          onOpenAction('/api/meeting-intakes/intake%2Fone/retry', 'task:work:ppt|4|f292.repair|intake/one|8')
        }
      >
        meeting
      </button>
    </>
  ),
}));

import { F307OwnerSurfaceRenderer } from '../F307OwnerSurfaceRenderer';

describe('F307 owner surface renderer', () => {
  it('opens the same exact Changes owner from the full Works list without guessing the artifact repository', () => {
    const surface = createWorkspaceModeSurface('artifacts', 'thread-a');
    const onOpenSurface = vi.fn();
    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          hostWorktreeId="registered-host-root"
          hostThreadId="thread-host"
          onOpenSurface={onOpenSurface}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="select-list-pr"]')?.click());
    expect(onOpenSurface).toHaveBeenCalledOnce();
    const opened = onOpenSurface.mock.calls[0]?.[0];
    expect(resolvePullRequestChangesTarget(opened)).toEqual({
      kind: 'github-pr',
      v: 1,
      repoFullName: 'owner/repo',
      prNumber: 7,
      worktreeId: 'registered-host-root',
      threadId: 'thread-host',
    });
    expect(opened.navigationOrigin).toEqual(listPr.origin);
  });

  it('opens a Changes file through the ordinary F063 owner with a scoped return origin', () => {
    const surface = createWorkspaceDestinationSurface(
      { kind: 'surface', id: 'changes', label: '变更', description: 'Diff', searchTerms: 'changes' },
      'thread-a',
      'listed-worktree',
    );
    expect(surface).not.toBeNull();
    if (!surface) return;
    const onOpenSurface = vi.fn();
    const onOpenArtifactWithReturn = vi.fn();
    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={onOpenSurface}
          onOpenArtifactWithReturn={onOpenArtifactWithReturn}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="changes-open-file"]')?.click());
    expect(onOpenSurface).toHaveBeenCalledTimes(1);
    const file = onOpenSurface.mock.calls[0]?.[0];
    expect(resolveFileTarget(file)).toMatchObject({ worktreeId: 'listed-worktree', path: 'src/owner.ts' });
    expect(file.navigationOrigin).toEqual({
      kind: 'workspace-changes',
      worktreeId: 'listed-worktree',
      threadId: 'thread-a',
    });
    expect(fileReturnLabel(file.navigationOrigin)).toBe('‹ 变更');
    expect(onOpenArtifactWithReturn).not.toHaveBeenCalled();
  });

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(artifactFixture, { revision: 7, threadId: 'thread-f310' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('suppresses Browser chrome in focus mode without replacing its owner surface', () => {
    const surface = createBrowserSurface({ ownerKey: 'chess', port: 3147, path: '/' });
    const render = (focusMode: boolean) => (
      <F307OwnerSurfaceRenderer
        surface={surface}
        focusMode={focusMode}
        onOpenSurface={() => undefined}
        onOpenArtifactWithReturn={() => undefined}
        onRefreshSurface={() => undefined}
        onRequestDetach={() => undefined}
      />
    );

    act(() => root.render(render(false)));
    const owner = container.querySelector('[data-testid="browser-owner"]');
    expect(owner?.getAttribute('data-preview-only')).toBe('false');

    act(() => root.render(render(true)));
    expect(container.querySelector('[data-testid="browser-owner"]')).toBe(owner);
    expect(owner?.getAttribute('data-preview-only')).toBe('true');
  });

  it('mounts the F309 content editor owner from persisted content/session refs', () => {
    const contentRef = 'project:alpha/assets/proposal.docx';
    const sessionRef = `editor-session:${'a'.repeat(64)}`;
    const surface = createContentEditorSurface({ contentRef, sessionRef });

    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    const owner = container.querySelector('[data-testid="content-editor-owner"]');
    expect(owner?.getAttribute('data-content-ref')).toBe(contentRef);
    expect(owner?.getAttribute('data-session-ref')).toBe(sessionRef);
  });

  it('restores the persisted Changes worktree and native Review Thread together', () => {
    const surface = createWorkspaceDestinationSurface(
      {
        kind: 'surface',
        id: 'changes',
        label: '变更',
        description: '看看这次改了什么',
        searchTerms: 'changes diff',
      },
      'thread-f306',
      'worktree-main',
    );
    if (!surface) throw new Error('Changes destination must produce an owner-backed surface');

    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    const owner = container.querySelector('[data-testid="changes-owner"]');
    expect(owner?.getAttribute('data-worktree-id')).toBe('worktree-main');
    expect(owner?.getAttribute('data-thread-id')).toBe('thread-f306');
  });

  it('renders the current Status owner inside its persisted Workbench surface', () => {
    const surface = createWorkspaceDestinationSurface(
      {
        kind: 'host',
        id: 'status',
        label: '状态与会话',
        description: '查看会话、对话标识与运行详情',
        searchTerms: 'status session',
      },
      'thread-f307',
      null,
    );
    if (!surface) throw new Error('Status destination must produce an owner-backed surface');

    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          statusSurface={<div data-testid="status-owner">status for thread-f307</div>}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="status-owner"]')?.textContent).toBe('status for thread-f307');
    expect(container.querySelector('[data-testid="f307-owner-unavailable"]')).toBeNull();
  });

  it('mounts the dedicated Capability Evolution workspace and opens lifecycle control', () => {
    const surface = createCapabilityEvolutionWorkspaceSurface('thread-f311');
    const onOpenSurface = vi.fn();

    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={onOpenSurface}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="open-program-lifecycle"]')?.click());

    expect(container.querySelector('[data-testid="open-program-lifecycle"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="open-program-lifecycle"]')?.getAttribute('data-target-thread-id'),
    ).toBe('thread-f311');
    expect(onOpenSurface).toHaveBeenCalledWith(
      createEvolutionProgramSurface('evolution-program:bcc336788a7df9d6075b1efb4c0a7e68'),
    );
  });

  it('passes an honest empty destination when a restored Capability Evolution workspace is unbound', () => {
    const surface = createCapabilityEvolutionWorkspaceSurface();

    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="open-program-lifecycle"]')?.getAttribute('data-target-thread-id'),
    ).toBe('none');
  });

  it('promotes the exact F232 Artifact selected from product Schedule', async () => {
    const surface = createWorkspaceDestinationSurface(
      {
        kind: 'mode',
        id: 'product-schedule',
        label: 'Schedule',
        description: '托付工作的截止与审阅时间',
        searchTerms: 'schedule deadline',
      },
      'thread-host',
    );
    if (!surface) throw new Error('Product Schedule must produce a terminal Workspace destination');
    const onOpenArtifactWithReturn = vi.fn();
    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={onOpenArtifactWithReturn}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    await act(async () => {
      container
        .querySelector('[data-testid="schedule-open-owner-artifact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenArtifactWithReturn).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        title: 'Tomorrow presentation',
        renderer: 'artifact-view',
        ownerStateRef: { owner: 'f232-thread-artifacts', key: 'thread-f310' },
      }),
      returnSurface: expect.objectContaining({
        objectRef: { kind: 'workspace-destination', id: 'mode:product-schedule' },
        resultTargetRef: {
          owner: 'f310-product-schedule-navigation',
          key: encodeURIComponent(JSON.stringify(['thread-host', 'task:work:ppt|4'])),
        },
      }),
    });
  });

  it.each([
    { revision: 8, threadId: 'thread-f310' },
    { revision: 7, threadId: 'other-thread' },
  ])('does not substitute a matching URL from another revision or thread: %j', async (changed) => {
    Object.assign(artifactFixture, changed);
    const surface = createWorkspaceDestinationSurface(
      {
        kind: 'mode',
        id: 'product-schedule',
        label: 'Schedule',
        description: 'Work',
        searchTerms: 'schedule',
      },
      'thread-host',
    );
    if (!surface) throw new Error('Expected Schedule surface');
    const open = vi.fn();
    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={open}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );
    await act(async () =>
      container
        .querySelector('[data-testid="schedule-open-owner-artifact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(open).not.toHaveBeenCalled();
    expect(container.textContent).toContain('这份内容已更新或暂时不可用');
    Object.assign(artifactFixture, { revision: 7, threadId: 'thread-f310' });
  });

  it('opens current approval refs and does not route retired meeting repairs to Approval', () => {
    const surface = createWorkspaceDestinationSurface({
      kind: 'mode',
      id: 'needs-me',
      label: 'Needs Me',
      description: '只放需要你判断或修复的事项',
      searchTerms: 'needs me',
    });
    if (!surface) throw new Error('Needs Me must produce a terminal Workspace destination');
    const onOpenSurface = vi.fn();
    const onRefreshSurface = vi.fn();
    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={surface}
          onOpenSurface={onOpenSurface}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={onRefreshSurface}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    act(() => {
      container
        .querySelector('[data-testid="needs-me-open-inline-approval"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({
        objectRef: { kind: 'workspace-destination', id: 'mode:approval' },
        resultTargetRef: {
          owner: 'f246-approval-navigation',
          key: encodeURIComponent(JSON.stringify(['global', 'proposal/one'])),
        },
      }),
    );

    act(() => {
      container
        .querySelector('[data-testid="needs-me-open-meeting-repair"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenSurface).toHaveBeenCalledTimes(1);
    expect(onRefreshSurface).toHaveBeenCalledTimes(1);
  });

  it('opens v2 Needs Me approval actions directly in the mailbox and preserves the return item', () => {
    const surface = createWorkspaceDestinationSurface({
      kind: 'mode',
      id: 'needs-me',
      label: 'Needs Me',
      description: 'Needs Me',
      searchTerms: 'needs me',
    });
    if (!surface) throw new Error('Expected the Needs Me destination');
    const navigate = vi.fn();
    const open = vi.fn();
    const refresh = vi.fn();
    window.addEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
    try {
      act(() => writeShellPresentation('v2'));
      act(() =>
        root.render(
          <F307OwnerSurfaceRenderer
            surface={surface}
            onOpenSurface={open}
            onOpenArtifactWithReturn={() => undefined}
            onRefreshSurface={refresh}
            onRequestDetach={() => undefined}
          />,
        ),
      );
      expect(navigate).not.toHaveBeenCalled();
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="needs-me-open-inline-approval"]')?.click());
      expect(navigate).toHaveBeenCalledOnce();
      expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
        section: 'pending',
        proposalId: 'proposal/one',
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
      act(() => writeShellPresentation('classic'));
    }
  });

  it('renders a Needs Me inline Approval descriptor through the Approval owner', () => {
    const needsMeSurface = createWorkspaceDestinationSurface({
      kind: 'mode',
      id: 'needs-me',
      label: 'Needs Me',
      description: '只放需要你判断或修复的事项',
      searchTerms: 'needs me',
    });
    if (!needsMeSurface) throw new Error('Needs Me must produce a terminal Workspace destination');
    const approvalSurface = createApprovalActionSurface(needsMeSurface, 'proposal/one');
    if (!approvalSurface) throw new Error('Needs Me must produce an inline Approval owner descriptor');

    act(() =>
      root.render(
        <F307OwnerSurfaceRenderer
          surface={approvalSurface}
          onOpenSurface={() => undefined}
          onOpenArtifactWithReturn={() => undefined}
          onRefreshSurface={() => undefined}
          onRequestDetach={() => undefined}
        />,
      ),
    );

    const approvalPanel = container.querySelector('[data-testid="approval-panel"]');
    expect(approvalPanel).not.toBeNull();
    expect(approvalPanel?.getAttribute('data-selected-proposal-id')).toBe('proposal/one');
  });
});
