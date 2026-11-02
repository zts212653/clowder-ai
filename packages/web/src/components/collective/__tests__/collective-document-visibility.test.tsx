import type { CollectiveDocumentResult, CollectiveDocumentTarget } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { annotationView } from '../../../../../collective-client/src/__tests__/shared-artifact-annotation-pages.fixture';
import { WorkspaceSurfaceVisibilityProvider } from '../../workbench/WorkspaceSurfaceVisibility';
import { registerCollectiveDocumentPort } from '../collective-document-port';
import { useCollectiveDocument } from '../use-collective-document';

it('drops owner bytes while a tab is hidden and requires a fresh read before showing the tab again', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const target: CollectiveDocumentTarget = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    connectionId: 'connection',
    humanId: 'human',
    artifactId: 'artifact',
    sourceEventId: 'source',
    channelId: 'general',
    ownerRevision: 1,
  };
  let complete: ((result: CollectiveDocumentResult) => void) | undefined;
  const request = vi.fn(
    () =>
      new Promise<CollectiveDocumentResult>((resolve) => {
        complete = resolve;
      }),
  );
  const unregister = registerCollectiveDocumentPort({
    hostKey: 'visibility-test',
    matches: () => true,
    request,
    returnTo: () => true,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Reader() {
    const reading = useCollectiveDocument({ target, hostKey: 'visibility-test' });
    return <p>{reading.reads?.[0]?.value.text ?? 'loading'}</p>;
  }
  const render = (visible: boolean) =>
    act(async () =>
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <Reader />
        </WorkspaceSurfaceVisibilityProvider>,
      ),
    );
  try {
    await render(true);
    await act(async () => complete?.({ kind: 'read', title: 'Original', value: annotationView() }));
    expect(container.textContent).toContain('同一份作品');
    await render(false);
    await render(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('loading');
    await act(async () => complete?.({ kind: 'error', code: 'access_denied' }));
    expect(container.textContent).not.toContain('同一份作品');
  } finally {
    await act(async () => root.unmount());
    unregister();
    container.remove();
  }
});
