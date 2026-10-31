import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createFilePreviewSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';
import { WORKBENCH_STORAGE_KEY, writeWorkbenchState } from '../workbench-persistence';

const surface = createFilePreviewSurface({ worktreeId: 'work', path: 'guide.md' });
beforeEach(() => {
  localStorage.clear();
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]), hydrated: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it('reports rejected layout storage without claiming that the new visit was persisted, and a genuine retry saves it', () => {
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  writeWorkbenchState(localStorage, layout);
  const original = localStorage.getItem(WORKBENCH_STORAGE_KEY);
  const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  const action = {
    type: 'activate-surface' as const,
    surfaceId: surface.id,
    entitlement: { kind: 'user' as const, reason: 'surface-tab' as const },
    visitThreadId: 'host-thread',
  };
  useF307ExperienceWorkbenchStore.getState().dispatch(action);
  const rejected = useF307ExperienceWorkbenchStore.getState().layout;
  expect(rejected.surfaces).toEqual([surface]);
  expect(rejected.recentSurfaceIdsByThread?.['host-thread']).toEqual([surface.id]);
  expect(rejected.activity).toContainEqual(
    expect.objectContaining({ id: 'restore-warning:storage', kind: 'restore-warning' }),
  );
  expect(localStorage.getItem(WORKBENCH_STORAGE_KEY)).toBe(original);
  quota.mockRestore();
  useF307ExperienceWorkbenchStore.getState().dispatch(action);
  expect(useF307ExperienceWorkbenchStore.getState().layout.activity).not.toContainEqual(
    expect.objectContaining({ id: 'restore-warning:storage' }),
  );
  expect(JSON.parse(localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? '{}').recentSurfaceIdsByThread).toEqual({
    'host-thread': [surface.id],
  });
});
