import { collectiveDocumentTargetSchema } from '@cat-cafe/shared';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CollectiveDocumentSurface } from '../CollectiveDocumentSurface';

const { returnTo } = vi.hoisted(() => ({ returnTo: vi.fn(() => true) }));
vi.mock('../use-collective-document', () => ({
  useCollectiveDocument: () => ({
    reads: [2, 4].map((ownerRevision) => ({
      title: '原件.md',
      value: {
        ownerRevision,
        text: `原件第${ownerRevision}版`,
        blobDigest: `sha256:${'a'.repeat(64)}`,
        view: { canWrite: false },
      },
    })),
    port: { returnTo },
  }),
}));
vi.mock('@/components/content-review/useContentOpen', () => ({ useContentOpen: () => ({ openContent: vi.fn() }) }));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: ({ reviewAction }: { reviewAction: ReactNode }) => <>{reviewAction}</>,
}));

it('opens each compared pane’s own original discussion version without carrying the comparison target', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const target = collectiveDocumentTargetSchema.parse({
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    connectionId: 'connection',
    humanId: 'human',
    artifactId: 'artifact',
    sourceEventId: 'source',
    channelId: 'general',
    ownerRevision: 2,
    comparisonOwnerRevision: 4,
    projectReturn: { roadmapId: 'project', channelId: 'general', referenceId: 'reference' },
  });
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () => root.render(<CollectiveDocumentSurface source={{ hostKey: 'host', target }} />));
    for (const revision of [2, 4]) {
      const button = host.querySelector<HTMLButtonElement>(`[data-owner-revision="${revision}"] button`);
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(returnTo).toHaveBeenLastCalledWith(
        { ...target, ownerRevision: revision, comparisonOwnerRevision: undefined },
        'discussion',
      );
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
