import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanonicalWorkspaceFileSurface } from '../CanonicalWorkspaceFileSurface';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetch(...args) }));
const container = document.createElement('div');
const root = createRoot(container);
const original = useF307ExperienceWorkbenchStore.getState();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.render(null));
  useF307ExperienceWorkbenchStore.setState(original, true);
  fetch.mockReset();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('file-tree and artifact aliases converge before mounting a second editable surface', async () => {
  const alias = createFileSurface({ worktreeId: 'human-worktree-name', path: 'notes.md', scrollToLine: 17 });
  const canonical = createFileSurface({ worktreeId: `f063_root_v1_${'a'.repeat(64)}`, path: 'notes.md' });
  useF307ExperienceWorkbenchStore.setState({
    layout: { ...createInitialWorkbenchState([canonical, alias]), activeSurfaceId: alias.id },
  });
  let finish: ((value: unknown) => void) | undefined;
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <CanonicalWorkspaceFileSurface surface={alias} onBack={() => undefined}>
        <input data-testid="editor" defaultValue="unsaved" />
      </CanonicalWorkspaceFileSurface>,
    ),
  );
  expect(container.querySelector('[data-testid="editor"]')).toBeNull();
  await act(async () =>
    finish!({
      ok: true,
      json: async () => ({ worktreeId: canonical.ownerStateRef.key, path: 'notes.md', kind: 'file' }),
    }),
  );
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  expect(layout.surfaces).toHaveLength(1);
  expect(layout.surfaces[0]?.id).toBe(canonical.id);
  expect(layout.surfaces[0]?.resultTargetRef?.key).toContain('17');
  await act(async () =>
    root.render(
      <CanonicalWorkspaceFileSurface surface={layout.surfaces[0]!} onBack={() => undefined}>
        <input data-testid="editor" defaultValue="unsaved" />
      </CanonicalWorkspaceFileSurface>,
    ),
  );
  expect(container.querySelector('[data-testid="editor"]')).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
});
