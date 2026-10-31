import { expect, it } from 'vitest';
import { parseFileNavigationOrigin } from '../file-navigation-origin';
import { createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';
import { workspaceFileReturnAction } from '../workspace-file-return';

it('admits the actual tools viewport and source host thread without converting it to Home', () => {
  const origin = {
    kind: 'workspace-tools-search',
    threadId: 'thread-tools',
    query: 'DESIGN.md',
    viewportOffsetPx: -22,
  };
  expect(parseFileNavigationOrigin(origin)).toEqual(origin);
  const parsed = parseFileNavigationOrigin(origin);
  if (!parsed || parsed.kind === 'evolution-media') throw new Error('ordinary tools origin must be admitted');
  expect(workspaceFileReturnAction(parsed, 'file-owner-other-thread')).toEqual(origin);
  const surface = createFileSurface({ worktreeId: 'worktree-a', path: 'DESIGN.md', navigationOrigin: parsed });
  const restored = restoreWorkbenchState(JSON.parse(JSON.stringify(createInitialWorkbenchState([surface]))));
  expect(restored.surfaces[0].navigationOrigin).toEqual(origin);
});

it('rejects invalid threads, coordinates and queries beyond the actual workspace API contract', () => {
  const valid = { kind: 'workspace-tools-search', threadId: 'thread', query: 'a'.repeat(200), viewportOffsetPx: 84 };
  expect(parseFileNavigationOrigin(valid)).toEqual(valid);
  for (const override of [
    { threadId: '' },
    { threadId: 'x'.repeat(257) },
    { query: '' },
    { query: 'a'.repeat(201) },
    { viewportOffsetPx: Infinity },
    { viewportOffsetPx: undefined },
  ])
    expect(parseFileNavigationOrigin({ ...valid, ...override })).toBeNull();
});
