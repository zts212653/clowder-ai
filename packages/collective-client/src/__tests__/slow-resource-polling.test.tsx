// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { ProjectMaterialsProvider, useProjectMaterials } from '../ProjectMaterialsContext.js';
import type { ProjectMaterialClient } from '../project-material-client.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';
import { useSharedArtifactManagement } from '../use-shared-artifact-management.js';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps a slow permission read current across polling ticks and still refreshes after an explicit change', async () => {
  const artifact = {
    serviceInstanceId: 'svc_fixture',
    collectiveId: 'col_fixture',
    artifactId: 'art_fixture',
    accessRevision: 1,
  } as SharedArtifact;
  let revision = 1;
  const read = vi.fn(
    () =>
      new Promise((resolve) => {
        const snapshot = `snapshot-${revision}`;
        setTimeout(() => resolve({ snapshot, members: [], offset: 0, total: 0 }), 2_500);
      }),
  );
  const state = {
    status: 'ready',
    humanId: 'human_fixture',
    refresh: async () => {},
    api: { management: { read, hasPending: () => false } },
  } as unknown as CollectiveArtifactState;
  let manager: ReturnType<typeof useSharedArtifactManagement>;
  function Harness() {
    manager = useSharedArtifactManagement(artifact);
    return null;
  }
  await act(async () =>
    root.render(
      <CollectiveArtifactContext.Provider value={state}>
        <Harness />
      </CollectiveArtifactContext.Provider>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(2_600));
  expect(manager!.value?.snapshot).toBe('snapshot-1');
  expect(read).toHaveBeenCalledTimes(1);
  let changed: Promise<void>;
  await act(async () => {
    changed = manager!.run(async () => {
      revision = 2;
    });
  });
  await act(async () => vi.advanceTimersByTimeAsync(2_600));
  await changed!;
  expect(manager!.value?.snapshot).toBe('snapshot-2');
});

it('finishes a slow project-material read before polling again', async () => {
  const feed = { items: [], pendingCount: 0, unavailable: [] };
  const list = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(feed), 31_000)));
  const client = { namespace: 'fixture-world', list } as unknown as ProjectMaterialClient;
  let materials: ReturnType<typeof useProjectMaterials>;
  function Harness() {
    materials = useProjectMaterials('roadmap_fixture');
    return null;
  }
  await act(async () =>
    root.render(
      <ProjectMaterialsProvider client={client}>
        <Harness />
      </ProjectMaterialsProvider>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(32_000));
  expect(materials!.loading).toBe(false);
  expect(materials!.error).toBe(false);
  expect(materials!.feed).toEqual(feed);
  expect(list).toHaveBeenCalledTimes(1);
});
