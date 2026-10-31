import { describe, expect, it } from 'vitest';
import { parseFileNavigationOrigin } from '../file-navigation-origin';
import { createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';
import { workspaceFileReturnAction } from '../workspace-file-return';

describe('Home search source position', () => {
  it('keeps the source search viewport offset through file persistence and named return', () => {
    const origin = { kind: 'workspace-home-search' as const, query: 'DESIGN.md', viewportOffsetPx: 84 };
    const file = createFileSurface({ worktreeId: 'work', path: 'DESIGN.md', navigationOrigin: origin });
    const restored = restoreWorkbenchState(JSON.parse(JSON.stringify(createInitialWorkbenchState([file]))));
    expect(restored.surfaces[0]?.navigationOrigin).toEqual(origin);
    expect(parseFileNavigationOrigin(origin)).toEqual(origin);
    expect(workspaceFileReturnAction(origin, 'canonical-work')).toEqual(origin);
  });

  it.each([Infinity, -Infinity, NaN, '84', null])('rejects invalid source geometry %s', (viewportOffsetPx) => {
    expect(
      parseFileNavigationOrigin({ kind: 'workspace-home-search', query: 'DESIGN.md', viewportOffsetPx }),
    ).toBeNull();
  });

  it('keeps old query-only file origins readable without inventing a historical position', () => {
    const origin = { kind: 'workspace-home-search' as const, query: 'DESIGN.md' };
    expect(parseFileNavigationOrigin(origin)).toEqual(origin);
    expect(workspaceFileReturnAction(origin, 'work')).toEqual(origin);
  });
});
