// @vitest-environment jsdom
import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactReading } from '../SharedArtifactReading.js';
import { SharedArtifactRequestCards } from '../SharedArtifactRequestCards.js';
import { SharedArtifactSurface } from '../SharedArtifactSurface.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('opens an older candidate from the requested page and drops old pages when owner state changes', async () => {
  const record = (id: string, candidate = false) =>
    ({
      requestId: id,
      target: { humanId: 'human', catId: 'codex61-sol' },
      state: 'proposal_ready',
      annotationIds: ['note'],
      ownerRevision: 1,
      requestEventId: `event-${id}`,
      ...(candidate ? { latestProposalRef: 'original-candidate' } : {}),
    }) as CollectiveModificationProjection;
  const older = record('older', true);
  const artifact = {
    artifactId: 'artifact',
    mediaType: 'text/markdown',
    contentRef: 'content',
    accessRevision: 1,
    availability: 'available',
    versions: [],
  } as unknown as SharedArtifact;
  const first = {
    contentRef: 'content',
    ownerRevision: 1,
    blobDigest: 'same',
    view: { review: { revision: 1 } },
    modifications: { snapshot: 'snapshot-one', total: 2, offset: 0, nextOffset: 1, requests: [record('recent')] },
  } as unknown as SharedMarkdownView;
  const modificationPage = first.modifications;
  if (!modificationPage) throw new Error('Expected an initial owner page');
  const moreRequests = vi.fn(
    async () =>
      ({
        ...first,
        modifications: {
          ...first.modifications,
          requests: [record('recent'), older],
          nextOffset: undefined,
        },
      }) as SharedMarkdownView,
  );
  const compare = vi.fn();
  const state = {
    catalogue: [artifact],
    api: { moreRequests },
    compare,
    catName: () => 'Sol',
    sourceMessage: () => undefined,
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (view: SharedMarkdownView) =>
    root.render(
      <CollectiveArtifactContext.Provider value={state}>
        <SharedArtifactRequestCards view={view} />
      </CollectiveArtifactContext.Provider>,
    );
  try {
    await act(async () => render(first));
    expect(moreRequests).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')?.click());
    expect(moreRequests).toHaveBeenCalledOnce();
    const open = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '查看对照');
    expect(open).toBeDefined();
    await act(async () => open?.click());
    expect(compare).toHaveBeenCalledWith('older', older);
    await act(async () => render({ ...first, modifications: { ...modificationPage, snapshot: 'snapshot-two' } }));
    expect(host.textContent).not.toContain('查看对照');
    expect(host.textContent).toContain('更早的修改记录');
    const preview = vi.fn(async () => ({ proposal: { response: '原来的候选正文', edits: [] } }));
    const reading = {
      ...first,
      text: 'Owner text',
      view: { ...first.view, review: { ...first.view.review, annotations: [] } },
    };
    const selectedState = {
      ...state,
      status: 'ready',
      catalogue: [{ ...artifact, versions: [{ ownerRevision: 1 }] }],
      selected: { artifactId: artifact.artifactId, requestId: older.requestId, request: older },
      api: { ...state.api, read: async () => reading, previewModification: preview },
    } as unknown as CollectiveArtifactState;
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={selectedState}>
          <SharedArtifactReading>
            <SharedArtifactSurface onReturnToSource={() => {}} onOpenDiscussion={() => {}} />
          </SharedArtifactReading>
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ artifactId: artifact.artifactId }), {
      requestId: 'older',
      proposalRef: 'original-candidate',
    });
    expect(host.textContent).toContain('原来的候选正文');
  } finally {
    await act(async () => root.unmount());
  }
});
