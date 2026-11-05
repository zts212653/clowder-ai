// @vitest-environment jsdom
import type { CollectiveProjectArtifactItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { ProjectArtifactSurface } from '../ProjectArtifactSurface.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';
import { roadmap } from './collaboration-cards.fixture.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const version = (n: number) => ({
  ownerRevision: n,
  blobDigest: `sha256:${String(n).repeat(64)}`,
  receiptRef: `receipt:${n}`,
});
const artifact: SharedArtifact = {
  serviceInstanceId: roadmap.serviceInstanceId,
  collectiveId: roadmap.collectiveId,
  artifactId: 'artifact_guide',
  contentRef: 'content:guide',
  title: '插件接入指南',
  mediaType: 'text/markdown',
  sourceEventId: roadmap.sourceEventId,
  sourceLocation: roadmap.sourceLocation,
  publishedByHumanId: roadmap.accountableHumanId,
  revision: 4,
  versions: [{ ...version(4), recordedAt: roadmap.createdAt }],
  versionCount: 4,
  availability: 'available',
  accessRevision: 1,
  canApply: false,
  createdAt: roadmap.createdAt,
  updatedAt: roadmap.updatedAt,
};
const item: CollectiveProjectArtifactItem = {
  reference: {
    ...roadmap,
    referenceId: 'ref-guide',
    artifactId: artifact.artifactId,
    versionRef: version(2),
    status: 'active',
    history: [
      {
        revision: 1,
        action: 'attach',
        actor: roadmap.history[0]!.actor,
        at: roadmap.createdAt,
        sourceEventId: roadmap.sourceEventId,
        versionRef: version(2),
      },
    ],
  },
  availability: 'available',
  artifact,
  hasUpdate: true,
  latestVersionRef: version(4),
  usedBy: [],
};

it('opens the project’s exact v2, offers explicit owner choices, and never opens latest from the project card', async () => {
  const open = vi.fn(),
    change = vi.fn().mockResolvedValue({ outcome: 'changed', item });
  const state = {
    humanId: roadmap.accountableHumanId,
    status: 'ready',
    catalogue: [artifact],
    api: {
      projectReferences: { namespace: 'member', list: async () => ({ items: [item], removedReferences: [] }), change },
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={state}>
          <ProjectArtifactSurface roadmap={roadmap} works={[]} artifacts={[artifact]} status="ready" onOpen={open} />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(host.textContent).toContain('本项目用的版本');
    const exact = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('打开本项目用的 v2'),
    );
    expect(exact).toBeTruthy();
    await act(async () => exact!.click());
    expect(open).toHaveBeenCalledWith(artifact, 2, {
      projectReturn: {
        roadmapId: roadmap.roadmapId,
        referenceId: item.reference.referenceId,
        channelId: roadmap.sourceLocation.channelId,
      },
    });
    expect(open).not.toHaveBeenCalledWith(artifact, 4);
    const keep = [...host.querySelectorAll('button')].find((button) => button.textContent === '保持 v2');
    await act(async () => keep!.click());
    expect(change).toHaveBeenCalledWith({
      roadmapId: roadmap.roadmapId,
      artifactId: artifact.artifactId,
      action: 'keep',
      expectedRevision: 1,
      versionRef: version(4),
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('does not expose owner controls or stale title on an unavailable reference', async () => {
  const hidden = { reference: item.reference, availability: 'access_denied', usedBy: [], hasUpdate: false };
  const state = {
    humanId: 'other-member',
    status: 'ready',
    catalogue: [artifact],
    api: {
      projectReferences: {
        namespace: 'other',
        list: async () => ({ items: [hidden], removedReferences: [] }),
        change: vi.fn(),
      },
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={state}>
          <ProjectArtifactSurface roadmap={roadmap} works={[]} artifacts={[artifact]} status="ready" />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    expect(host.textContent).toContain('这件作品现在打不开');
    expect(host.textContent).not.toContain(artifact.title);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.startsWith('换用'))).toBe(false);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.startsWith('移出'))).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it('refreshes an in-flight reference when its authenticated transport is renewed, without accepting the retired response', async () => {
  let finishOld: ((feed: { items: CollectiveProjectArtifactItem[]; removedReferences: [] }) => void) | undefined;
  const old = new Promise<{ items: CollectiveProjectArtifactItem[]; removedReferences: [] }>((resolve) => {
    finishOld = resolve;
  });
  const list = vi.fn(async () => ({ items: [item], removedReferences: [] }));
  const state = (read: () => Promise<unknown>) =>
    ({
      humanId: roadmap.accountableHumanId,
      status: 'ready',
      catalogue: [artifact],
      api: { projectReferences: { namespace: 'same-human', list: read, change: vi.fn() } },
    }) as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (value: CollectiveArtifactState) =>
    act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={value}>
          <ProjectArtifactSurface roadmap={roadmap} works={[]} artifacts={[artifact]} status="ready" />
        </CollectiveArtifactContext.Provider>,
      ),
    );
  try {
    await render(state(() => old));
    await render(state(list));
    expect(list).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('打开本项目用的 v2');
    await act(async () => finishOld?.({ items: [], removedReferences: [] }));
    expect(host.textContent).toContain('打开本项目用的 v2');
  } finally {
    await act(async () => root.unmount());
  }
});
