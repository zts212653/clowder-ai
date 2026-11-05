// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import { collectiveArtifactClient } from '../collective-artifact-client.js';
import { SharedArtifactHistory } from '../SharedArtifactHistory.js';
import { SharedArtifactToolbar } from '../SharedArtifactToolbar.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';
import { annotationArtifact as artifact } from './shared-artifact-annotation-pages.fixture.js';

it('fetches explicit history pages and selects a version absent from the head-only catalogue', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const snapshot = `sha256:${'a'.repeat(64)}`;
  const initial = artifact.versions[0];
  if (!initial) throw new Error('Expected original fixture version');
  const selected = { ...artifact, versionCount: 61, versions: [{ ...initial, ownerRevision: 61 }] };
  const calls: Record<string, unknown>[] = [];
  const request: ClientRequest = async (path, options) => {
    expect(path).toBe('/api/artifacts/history');
    const input = JSON.parse(String(options?.body)) as Record<string, unknown>;
    calls.push(input);
    const offset = Number(input.offset ?? 0);
    if (offset) {
      expect(input.snapshotOwnerRevision).toBe(61);
      expect(input.expectedSnapshot).toBe(snapshot);
    }
    const versions = Array.from({ length: Math.min(30, 61 - offset) }, (_, index) => ({
      ...artifact.versions[0],
      ownerRevision: 61 - offset - index,
      receiptRef: `receipt:${61 - offset - index}`,
    }));
    return {
      artifactId: artifact.artifactId,
      contentRef: artifact.contentRef,
      sourceEventId: artifact.sourceEventId,
      snapshotOwnerRevision: 61,
      snapshot,
      total: 61,
      offset,
      versions,
      ...(offset + versions.length < 61 ? { nextOffset: offset + versions.length } : {}),
    } as never;
  };
  const api = collectiveArtifactClient(request, artifact, 'history-visitor');
  const open = vi.fn(),
    close = vi.fn();
  const shared = {
    api,
    catalogue: [selected],
    status: 'ready',
    humanId: 'reader',
    open,
    humanName: () => '作者',
    catName: () => 'Sol',
    sourceMessage: () => undefined,
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (prefix: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.startsWith(prefix));
      expect(button).toBeDefined();
      button?.click();
    });
  try {
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={shared}>
          <SharedArtifactHistory artifact={selected} onClose={close} />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(host.querySelectorAll('ol > li')).toHaveLength(30);
    expect(calls).toHaveLength(1);
    const newer = { ...selected, versionCount: 62, versions: [{ ...initial, ownerRevision: 62 }] };
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={{ ...shared, catalogue: [newer] }}>
          <SharedArtifactHistory artifact={newer} onClose={close} />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(calls).toHaveLength(1);
    await click('更早的版本');
    expect(host.querySelectorAll('ol > li')).toHaveLength(60);
    await click('更早的版本');
    expect(host.querySelectorAll('ol > li')).toHaveLength(61);
    expect(calls).toHaveLength(3);
    await click('查看第 1 版');
    expect(open).toHaveBeenCalledWith(newer, 1);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('does not create 10000 toolbar options from a 10000-version work', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const initial = artifact.versions[0];
  if (!initial) throw new Error('Expected original fixture version');
  const work = { ...artifact, versionCount: 10000, versions: [{ ...initial, ownerRevision: 10000 }] };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SharedArtifactToolbar
          artifact={work}
          ownerRevision={1}
          onReturnToSource={() => {}}
          onOpenDiscussion={() => {}}
        />,
      ),
    );
    expect(host.querySelectorAll('option')).toHaveLength(2);
    expect([...host.querySelectorAll('option')].map((option) => option.value)).toEqual(['1', '10000']);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('coalesces visible request receipt lookups without caching their authority across visits', async () => {
  const calls: unknown[] = [];
  const request: ClientRequest = async (path, options) => {
    expect(path).toBe('/api/artifacts/receipts/by-request');
    calls.push(JSON.parse(String(options?.body)));
    return { receipts: [] } as never;
  };
  const api = collectiveArtifactClient(request, artifact, 'receipt-visitor');
  await Promise.all([api.receipts('request-a'), api.receipts('request-b'), api.receipts('request-a')]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ requestEventIds: ['request-a', 'request-b'] });
  await api.receipts('request-a');
  expect(calls).toHaveLength(2);
});
