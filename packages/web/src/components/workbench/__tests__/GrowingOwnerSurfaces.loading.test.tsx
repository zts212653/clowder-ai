import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsMeOwnerSurface, ProductScheduleOwnerSurface } from '../GrowingOwnerSurfaces';
import { createWorkspaceDestinationSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  navigate: vi.fn(),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: () => ({ ownerReads: mocks.ownerReads, loading: false, error: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({
  resolveEntrustedWorkActionTarget: () => ({ kind: 'message' }),
  navigateToEntrustedWorkAction: mocks.navigate,
}));

const artifact: GlobalArtifactDTO = {
  type: 'file',
  name: 'Prepared handbook',
  url: '/uploads/handbook.md',
  createdAt: 700,
  sourceMessageId: 'published-message',
  catId: 'codex-sol',
  threadId: 'thread-source',
  threadTitle: 'Source',
};
const subjectRef = 'task:work:handbook';
const ownerRef = 'task:item:handbook';
const producerRef = 'interaction:direction';
const actionRef = 'message:thread-source:question#direction';

function preparedOwnerRead(): EntrustedWorkOwnerReadV1 {
  return {
    envelope: {
      subjectRef,
      ownerRef,
      admissionReceiptRef: 'task:receipt:handbook:2',
      sourceRefs: ['message:source'],
      revision: 2,
      freshness: { state: 'current', observedRevision: 2 },
      visibility: { ownerUserId: 'owner', human: true, cat: true },
    },
    brief: {
      outcome: { state: 'known', value: 'A prepared handbook', ownerRef, revision: 2 },
      current: { state: 'doing', ownerRef, revision: 2 },
      verifiedMilestone: { kind: 'needs_judgment', evidenceRef: producerRef, revision: 3 },
      nextOwner: {
        kind: 'human',
        ownerRef: 'user:owner',
        evidence: [{ producerId: 'f306.runtime_interaction', ownerRef: producerRef, revision: 3 }],
      },
      needsMe: {
        state: 'needed',
        evidence: [{ producerId: 'f306.runtime_interaction', ownerRef: producerRef, revision: 3 }],
      },
    },
    preparedArtifact: {
      artifactRef: '/uploads/handbook.md',
      artifactRevision: '700',
      completenessRef: 'message:published#available:700',
      previewRef: 'message:published#preview:700',
      openInWorkspaceRef: 'workspace:artifact:thread-source:700:/uploads/handbook.md',
    },
    timeRefs: [{ role: 'review_by', subjectRef, ownerRef, revision: 2, value: 900 }],
    attentionReceipts: [
      {
        eligible: true,
        producer: {
          producerId: 'f306.runtime_interaction',
          ownerRef: producerRef,
          subjectRef: producerRef,
          revision: 3,
        },
        taskRef: { subjectRef, observedRevision: 2 },
        kind: 'judgment',
        reasonCode: 'runtime_interaction:choice',
        recommendation: 'Use the prepared direction',
        salience: 'normal',
        action: { actionRef, expectedProducerRevision: 3 },
        reEvaluateActionRef: 'interaction:direction#reevaluate',
      },
    ],
  };
}

describe('F310 prepared Artifact loading in real owner surfaces', () => {
  let container: HTMLDivElement;
  let root: Root;
  let finishCatalog: (response: Response) => void;
  const open = vi.fn();
  const refresh = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.ownerReads = [preparedOwnerRead()];
    mocks.fetch.mockReset();
    mocks.navigate.mockReset();
    open.mockReset();
    refresh.mockReset();
    const catalog = new Promise<Response>((resolve) => {
      finishCatalog = resolve;
    });
    mocks.fetch.mockImplementation((path: string) => {
      if (path !== '/api/artifacts') throw new Error(`Unexpected request: ${path}`);
      return catalog;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(projection: 'product-schedule' | 'needs-me') {
    const surface = createWorkspaceDestinationSurface({
      kind: 'mode',
      id: projection,
      label: projection,
      description: 'Prepared work',
      searchTerms: projection,
    });
    if (!surface) throw new Error('Expected a real Workspace destination');
    await act(async () =>
      root.render(
        projection === 'product-schedule' ? (
          <ProductScheduleOwnerSurface surface={surface} onOpenArtifactWithReturn={open} />
        ) : (
          <NeedsMeOwnerSurface
            surface={surface}
            onOpenArtifactWithReturn={open}
            onOpenSurface={vi.fn()}
            onRefreshSurface={refresh}
          />
        ),
      ),
    );
  }

  function button(id: string): HTMLButtonElement {
    const node = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!node) throw new Error(`Missing button ${id}`);
    return node;
  }

  async function loadCatalog(artifacts: GlobalArtifactDTO[]) {
    await act(async () => finishCatalog(new Response(JSON.stringify({ artifacts }))));
  }

  it.each([
    'product-schedule',
    'needs-me',
  ] as const)('%s waits for its catalog and then opens the exact publication with the original return item', async (projection) => {
    await render(projection);
    const openButton = button(projection === 'needs-me' ? 'needs-me-open-artifact' : 'product-schedule-open-artifact');
    expect(openButton.disabled).toBe(true);
    expect(openButton.getAttribute('aria-busy')).toBe('true');
    act(() => openButton.click());
    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await loadCatalog([artifact]);
    expect(openButton.disabled).toBe(false);
    act(() => openButton.click());
    expect(open).toHaveBeenCalledOnce();
    const result = open.mock.calls[0]?.[0];
    expect(result.artifact.ownerStateRef).toEqual({ owner: 'f232-thread-artifacts', key: 'thread-source' });
    expect(result.artifact.title).toBe('Prepared handbook');
    expect(decodeURIComponent(result.returnSurface.resultTargetRef.key)).toContain(`${subjectRef}|2`);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps a genuine judgment actionable while only its Artifact catalog is loading', async () => {
    await render('needs-me');
    const judgment = button('needs-me-open-action');
    expect(judgment.disabled).toBe(false);
    act(() => judgment.click());
    expect(mocks.navigate).toHaveBeenCalledWith(actionRef);
    expect(refresh).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('retains compact recovery when a completed catalog has no exact publication', async () => {
    await render('product-schedule');
    await loadCatalog([{ ...artifact, createdAt: 701 }]);
    const openButton = button('product-schedule-open-artifact');
    expect(openButton.disabled).toBe(false);
    act(() => openButton.click());
    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('这份内容已更新或暂时不可用');
  });

  it.each([
    'product-schedule',
    'needs-me',
  ] as const)('%s opens an already prepared review while the unrelated F232 catalog is still pending', async (projection) => {
    const reviewId = `review-${'a'.repeat(64)}`;
    const ownerRead = preparedOwnerRead();
    if (!ownerRead.preparedArtifact) throw new Error('Expected a prepared owner coordinate');
    ownerRead.preparedArtifact = {
      ...ownerRead.preparedArtifact,
      artifactRef: 'content:reviewed-cover',
      openInWorkspaceRef: `workspace:content-review:thread-source:${reviewId}`,
    };
    mocks.ownerReads = [ownerRead];
    await render(projection);
    const openButton = button(projection === 'needs-me' ? 'needs-me-open-artifact' : 'product-schedule-open-artifact');
    expect(openButton.disabled).toBe(false);
    expect(openButton.getAttribute('aria-busy')).toBe('false');
    act(() => openButton.click());
    expect(open).toHaveBeenCalledOnce();
    const result = open.mock.calls[0]?.[0];
    expect(result.artifact.ownerStateRef).toEqual({ owner: 'f309-content-review', key: reviewId });
    expect(result.artifact.resultTargetRef).toEqual({ owner: 'thread', key: 'thread-source' });
    expect(decodeURIComponent(result.returnSurface.resultTargetRef.key)).toContain(`${subjectRef}|2`);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
