import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
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

function mockRequests(read: (path: string) => Promise<Response>) {
  mocks.fetch.mockImplementation((path: string) => {
    if (path === '/api/session') return Promise.resolve(Response.json({ userId: 'owner' }));
    if (path === '/api/config/ignored-items') {
      return Promise.resolve(Response.json({ ownerUserId: 'owner', revision: 0, entries: [] }));
    }
    return read(path);
  });
}

function expectOnlyOwnerReads(projection: 'product-schedule' | 'needs-me') {
  expect(mocks.fetch.mock.calls.map(([path]) => path)).toEqual(
    projection === 'product-schedule' ? ['/api/session', '/api/config/ignored-items'] : [],
  );
}

describe('F310 prepared Artifact loading in real owner surfaces', () => {
  let container: HTMLDivElement;
  let root: Root;
  let finishCatalog: (response: Response) => void;
  const open = vi.fn();
  const refresh = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetCoCreatorConfigCacheForTest();
    // This owner-data loading fixture supplies its independent display config explicitly.
    primeCoCreatorConfigCache({ name: 'Prepared owner', aliases: [], mentionPatterns: ['@prepared-owner'] });
    mocks.ownerReads = [preparedOwnerRead()];
    mocks.fetch.mockReset();
    mocks.navigate.mockReset();
    open.mockReset();
    refresh.mockReset();
    const catalog = new Promise<Response>((resolve) => {
      finishCatalog = resolve;
    });
    mockRequests((path: string) => {
      if (path !== '/api/threads/thread-source/artifacts') throw new Error(`Unexpected request: ${path}`);
      return catalog.then((response) => response.clone());
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetCoCreatorConfigCacheForTest();
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
    await act(async () => finishCatalog(new Response(JSON.stringify({ threadId: 'thread-source', artifacts }))));
  }

  it('renders the configured human owner without adding an owner-data dependency', async () => {
    await render('needs-me');
    expect(container.querySelector('[data-testid="entrusted-work-brief"]')?.textContent).toContain('Prepared owner');
    expect(mocks.fetch.mock.calls.map(([path]) => path)).toEqual(['/api/threads/thread-source/artifacts']);
  });

  it.each([
    'product-schedule',
    'needs-me',
  ] as const)('%s opens its exact publication even when the unrelated global catalog times out', async (projection) => {
    mockRequests((path: string) => {
      if (path === '/api/artifacts') return Promise.reject(new Error('Request timed out'));
      if (path === '/api/threads/thread-source/artifacts') {
        return Promise.resolve(new Response(JSON.stringify({ threadId: 'thread-source', artifacts: [artifact] })));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await render(projection);
    await act(async () =>
      button(projection === 'needs-me' ? 'needs-me-open-artifact' : 'product-schedule-open-artifact').click(),
    );
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0].artifact.ownerStateRef).toEqual({
      owner: 'f232-thread-artifacts',
      key: 'thread-source',
    });
    expect(decodeURIComponent(open.mock.calls[0]?.[0].returnSurface.resultTargetRef.key)).toContain(`${subjectRef}|2`);
    expect(mocks.fetch.mock.calls.map(([path]) => path)).not.toContain('/api/artifacts');
  });

  it.each([
    'product-schedule',
    'needs-me',
  ] as const)('%s waits only for its original thread and opens the exact publication with the original return item', async (projection) => {
    await render(projection);
    const openButton = button(projection === 'needs-me' ? 'needs-me-open-artifact' : 'product-schedule-open-artifact');
    if (projection === 'product-schedule') {
      expectOnlyOwnerReads(projection);
      expect(openButton.disabled).toBe(false);
      act(() => openButton.click());
    }
    expect(openButton.disabled).toBe(true);
    expect(openButton.getAttribute('aria-busy')).toBe('true');
    act(() => openButton.click());
    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await loadCatalog([artifact]);
    expect(openButton.disabled).toBe(false);
    if (projection === 'needs-me') await act(async () => openButton.click());
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

  it('aborts an unfinished owner read on departure and never opens its late result', async () => {
    await render('product-schedule');
    act(() => button('product-schedule-open-artifact').click());
    const request = mocks.fetch.mock.calls.find(([path]) => path === '/api/threads/thread-source/artifacts');
    const signal = request?.[1]?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
    act(() => root.render(null));
    expect(signal?.aborted).toBe(true);
    await loadCatalog([artifact]);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps completed work in its original completed return selection', async () => {
    const work = preparedOwnerRead();
    work.completion = { recordedAt: 1000, evidenceRefs: ['message:accepted'] };
    work.brief.current.state = 'done';
    mocks.ownerReads = [work];
    await render('product-schedule');
    act(() => button('product-schedule-open-artifact').click());
    await loadCatalog([artifact]);
    expect(open).toHaveBeenCalledOnce();
    expect(decodeURIComponent(open.mock.calls[0]?.[0].returnSurface.resultTargetRef.key)).toContain(
      `${subjectRef}|2|completed`,
    );
  });

  it('retains compact recovery when a completed catalog has no exact publication', async () => {
    await render('product-schedule');
    await loadCatalog([{ ...artifact, createdAt: 701 }]);
    const openButton = button('product-schedule-open-artifact');
    expect(openButton.disabled).toBe(false);
    await act(async () => openButton.click());
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
    expectOnlyOwnerReads(projection);
  });

  it.each([
    'product-schedule',
    'needs-me',
  ] as const)('%s names the opened review tab after the review the card already shows', async (projection) => {
    // Real page 2026-09-23: "在 Workspace 打开" / "打开成果" opened the review as a generic "产物审阅" tab,
    // overwriting the title another entry had given the same review.
    const reviewId = `review-${'c'.repeat(64)}`;
    const ownerRead = preparedOwnerRead();
    if (!ownerRead.preparedArtifact) throw new Error('Expected a prepared owner coordinate');
    ownerRead.preparedArtifact = {
      ...ownerRead.preparedArtifact,
      artifactRef: '/uploads/panel.png',
      artifactRevision: '1',
      previewRef: `content-review:${reviewId}:round:1`,
      openInWorkspaceRef: `workspace:content-review:thread-source:${reviewId}`,
    };
    mocks.ownerReads = [ownerRead];
    mockRequests((path: string) => {
      if (path === '/api/artifacts') return Promise.resolve(new Response(JSON.stringify({ artifacts: [] })));
      if (path === `/api/artifact-reviews/${reviewId}`)
        return Promise.resolve(new Response(JSON.stringify({ review: { reviewId, title: '判断产物面板按钮文案' } })));
      if (path === `/api/artifact-reviews/${reviewId}/media/1`) return Promise.resolve(new Response(new Blob(['png'])));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:thumb', revokeObjectURL: () => undefined }));
    await render(projection);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => button(projection === 'needs-me' ? 'needs-me-open-artifact' : 'product-schedule-open-artifact').click());
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0].artifact.title).toBe('判断产物面板按钮文案');
  });
});
