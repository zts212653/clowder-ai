// @vitest-environment jsdom
import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactAnnotations } from '../SharedArtifactAnnotations.js';
import { SharedArtifactModificationCompare } from '../SharedArtifactModificationCompare.js';
import { SharedArtifactRequestCards } from '../SharedArtifactRequestCards.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('lets the requester cancel only its request and an authorized adopter decline a candidate without hiding its comparison', async () => {
  const request = {
    requestId: 'request',
    revision: 2,
    state: 'proposal_ready',
    ownerRevision: 1,
    requestingHumanId: 'requester',
    target: { humanId: 'cat-owner', catId: 'sol' },
    annotationIds: ['note'],
    latestProposalRef: 'candidate',
    sourceEventId: 'source',
  } as CollectiveModificationProjection;
  const artifact = {
    artifactId: 'artifact',
    contentRef: 'content',
    canApply: true,
    versions: [{ ownerRevision: 1 }],
  } as unknown as SharedArtifact;
  const view = {
    contentRef: 'content',
    view: { review: { revision: 1 } },
    modifications: { requests: [request] },
  } as unknown as SharedMarkdownView;
  const resolveModification = vi.fn(async (_artifact, _request, action) => ({
    ...request,
    state: 'cancelled',
    resolution: { kind: action === 'cancel' ? 'cancelled' : 'rejected' },
  }));
  const state = {
    catalogue: [artifact],
    humanId: 'requester',
    catName: () => 'Sol',
    sourceMessage: () => undefined,
    refresh: async () => {},
    compare: vi.fn(),
    api: {
      resolveModification,
      previewModification: async () => ({ request, proposal: { response: '保留的候选', edits: [] } }),
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (comparison: boolean) =>
    root.render(
      <CollectiveArtifactContext.Provider value={state}>
        {comparison ? (
          <SharedArtifactModificationCompare artifact={artifact} request={request} onClose={() => {}} />
        ) : (
          <SharedArtifactRequestCards view={view} />
        )}
      </CollectiveArtifactContext.Provider>,
    );
  try {
    await act(async () => render(false));
    const cancel = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '取消这次修改');
    expect(cancel).toBeDefined();
    await act(async () => cancel?.click());
    expect(resolveModification).toHaveBeenLastCalledWith(artifact, request, 'cancel');
    expect(host.textContent).toContain('已取消');
    expect(host.textContent).toContain('查看对照');
    await act(async () => render(true));
    const decline = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '不采用');
    expect(decline).toBeDefined();
    await act(async () => decline?.click());
    expect(resolveModification).toHaveBeenLastCalledWith(artifact, request, 'reject');
    expect(host.textContent).toContain('未采用');
    expect(host.textContent).toContain('保留的候选');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === '采用')).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps annotation, cat-change, comparison, and adoption controls in English', async () => {
  window.history.replaceState({}, '', '/?lang=en');
  const request = {
    requestId: 'request-english',
    revision: 2,
    state: 'proposal_ready',
    ownerRevision: 1,
    requestingHumanId: 'requester',
    target: { humanId: 'cat-owner', catId: 'sol' },
    annotationIds: ['annotation-english'],
    latestProposalRef: 'candidate-english',
    sourceEventId: 'source',
    requestEventId: 'request-event',
  } as CollectiveModificationProjection;
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact-english',
    contentRef: 'content-english',
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
    canApply: true,
    accessRevision: 1,
    versions: [{ ownerRevision: 1, blobDigest: `sha256:${'a'.repeat(64)}` }],
  } as unknown as SharedArtifact;
  const view = {
    contentRef: artifact.contentRef,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    text: 'Exact result',
    view: {
      canWrite: true,
      review: {
        revision: 1,
        annotations: [
          {
            id: 'annotation-english',
            author: { actorId: 'requester' },
            anchor: { quote: 'Exact result' },
            body: 'Please verify this sentence.',
            state: 'open',
          },
        ],
      },
      annotationPage: { offset: 0, total: 1 },
    },
    modifications: { requests: [request], total: 1, offset: 0 },
  } as unknown as SharedMarkdownView;
  const state = {
    catalogue: [artifact],
    humanId: 'requester',
    humanName: () => 'You',
    catName: () => 'Sol',
    sourceMessage: () => ({ body: 'Please revise this section.' }),
    refresh: async () => {},
    compare: vi.fn(),
    api: {
      receipts: async () => [],
      previewModification: async () => ({
        request,
        currentOwnerRevision: 1,
        proposal: {
          response: 'I clarified the sentence.',
          edits: [{ start: 0, end: 5, expectedText: 'Exact', replacement: 'Verified' }],
        },
      }),
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={state}>
          <SharedArtifactAnnotations view={view} onOpenDiscussion={() => undefined} />
          <SharedArtifactRequestCards view={view} />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(host.textContent).toContain('Resolve annotation');
    expect(host.textContent).toContain('View comparison');
    expect(host.innerHTML).not.toMatch(/[\u3400-\u9fff]/u);

    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={state}>
          <SharedArtifactModificationCompare artifact={artifact} request={request} onClose={() => undefined} />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(host.textContent).toContain('I clarified the sentence.');
    expect(host.textContent).toContain('Adopt');
    expect(host.innerHTML).not.toMatch(/[\u3400-\u9fff]/u);
  } finally {
    await act(async () => root.unmount());
    window.history.replaceState({}, '', '/');
  }
});
