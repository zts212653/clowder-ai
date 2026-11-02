// @vitest-environment jsdom
import {
  type CollectiveHostContextInit,
  collectiveDocumentClientReadySchema,
  collectiveDocumentOpenSchema,
} from '@cat-cafe/shared';
import { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useHostDocumentSurface } from '../use-host-document-surface.js';
import { annotationArtifact } from './shared-artifact-annotation-pages.fixture.js';

it('waits for the new Host handshake when a channel transition advances context after render', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const bridge: CollectiveHostContextInit = {
    type: 'collective:host-context-init',
    bridgeId: 'bridge-123',
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    connectionId: 'connection',
    humanId: 'human',
    authorityStatus: 'connected',
  };
  const host = document.createElement('div'),
    root = createRoot(host);
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  function Harness({ revision }: { revision: number }) {
    const context = useRef({ bridge, contextId: 'context-123', revision: 1 });
    // Matches the actual context publisher: context advances in an effect before the document bridge's effects.
    useEffect(() => {
      context.current = { bridge, contextId: 'context-123', revision };
    }, [revision]);
    useHostDocumentSurface({
      context,
      bridge,
      hostOrigin: 'https://host.example',
      generation: `channel-${revision}`,
      selection: { artifact: annotationArtifact, ownerRevision: revision, onReturn: () => {} },
    });
    return null;
  }
  const opened = () =>
    post.mock.calls.flatMap(([value]) => {
      const parsed = collectiveDocumentOpenSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  const ready = () =>
    post.mock.calls
      .flatMap(([value]) => {
        const parsed = collectiveDocumentClientReadySchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .at(-1);
  const acknowledge = async (value: NonNullable<ReturnType<typeof ready>>) => {
    const { type: _type, ...coordinates } = value;
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window.parent,
          origin: 'https://host.example',
          data: { type: 'collective:host-document-ready', ...coordinates },
        }),
      ),
    );
  };
  try {
    await act(async () => root.render(<Harness revision={1} />));
    const first = ready();
    if (!first) throw new Error('Missing capability handshake');
    expect(opened()).toHaveLength(0);
    await acknowledge(first);
    expect(opened()).toHaveLength(1);
    await act(async () => root.render(<Harness revision={2} />));
    const second = ready();
    if (!second) throw new Error('Missing renewed handshake');
    expect(second.contextRevision).toBe(2);
    expect(opened()).toHaveLength(1);
    await acknowledge(first);
    expect(opened()).toHaveLength(1);
    await acknowledge(second);
    expect(opened()).toHaveLength(2);
    expect(opened().at(-1)?.ref).toMatchObject({ ownerRevision: 2, contextRevision: 2 });
  } finally {
    await act(async () => root.unmount());
    post.mockRestore();
  }
});
