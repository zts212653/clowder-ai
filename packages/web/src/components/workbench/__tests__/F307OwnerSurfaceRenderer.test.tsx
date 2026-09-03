import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityEvolutionWorkspaceSurface } from '../capability-evolution-workspace-adapter';
import {
  createApprovalActionSurface,
  createEvolutionProgramSurface,
  createWorkspaceDestinationSurface,
} from '../real-surface-adapters';

const ARTIFACT_COORDINATE = {
  artifactRef: 'artifact:ppt:tomorrows-ppt',
  artifactRevision: '7',
  completenessRef: 'artifact:ppt:tomorrows-ppt#available:7',
  previewRef: 'artifact:ppt:tomorrows-ppt#preview:7',
  openInWorkspaceRef: 'workspace:artifact:thread-f310:7:artifact:ppt:tomorrows-ppt',
};

vi.mock('@/components/workspace/ChangesPanel', () => ({
  ChangesPanel: ({ worktreeId, threadId }: { worktreeId: string | null; threadId?: string | null }) => (
    <div data-testid="changes-owner" data-worktree-id={worktreeId} data-thread-id={threadId} />
  ),
}));

vi.mock('@/components/capability-evolution/CapabilityEvolutionWorkspace', () => ({
  CapabilityEvolutionWorkspace: ({ onOpenProgram }: { onOpenProgram: (programId: string) => void }) => (
    <button
      type="button"
      data-testid="open-program-lifecycle"
      onClick={() => onOpenProgram('evolution-program:bcc336788a7df9d6075b1efb4c0a7e68')}
    >
      能力进化 Workspace
    </button>
  ),
}));

vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: () => ({
    artifacts: [
      {
        type: 'file',
        name: 'Tomorrow presentation',
        catId: 'codex-sol',
        createdAt: 7,
        sourceMessageId: null,
        url: 'artifact:ppt:tomorrows-ppt',
        threadId: 'thread-f310',
        threadTitle: 'PPT source',
      },
    ],
    loading: false,
    error: false,
    refetch: vi.fn(),
  }),
}));

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
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
        description: '查看 Session、Thread ID 与运行详情',
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
    expect(onOpenSurface).toHaveBeenCalledWith(
      createEvolutionProgramSurface('evolution-program:bcc336788a7df9d6075b1efb4c0a7e68'),
    );
  });

  it('promotes the exact F232 Artifact selected from product Schedule', () => {
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

    act(() => {
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

  it('opens inline approval and meeting repair refs in the existing Approval owner surface', () => {
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
    expect(onOpenSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({
        objectRef: { kind: 'workspace-destination', id: 'mode:approval' },
        resultTargetRef: {
          owner: 'f246-approval-navigation',
          key: encodeURIComponent(JSON.stringify(['global', 'intake/one'])),
        },
      }),
    );
    expect(onRefreshSurface).toHaveBeenCalledTimes(2);
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
