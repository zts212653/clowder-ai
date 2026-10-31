import { afterEach, describe, expect, it } from 'vitest';
import { createMessagePublicationSurface } from '../message-publication-surface';
import { createPublicationSurface } from '../publication-surface';
import {
  createFilePreviewSurface as createFileSurface,
  createFileSurface as createLegacyFileSurface,
  isRealSurfaceOwnerAvailable,
} from '../real-surface-adapters';
import type { WorkbenchAction, WorkbenchLayoutState } from '../workbench-contract';
import { createInitialWorkbenchState, reduceWorkbench, restoreWorkbenchState } from '../workbench-model';
import { loadWorkbenchState, WORKBENCH_STORAGE_KEY, writeWorkbenchState } from '../workbench-persistence';
import { selectRecentSurfaces } from '../workbench-recent-visits';

const user = { kind: 'user', reason: 'surface-tab' } as const;
const a = createFileSurface({ worktreeId: 'work', path: 'a.md' });
const b = createFileSurface({ worktreeId: 'work', path: 'b.md' });
const c = createFileSurface({ worktreeId: 'work', path: 'c.md' });
const d = createFileSurface({ worktreeId: 'work', path: 'd.md' });
const initial = () => createInitialWorkbenchState([a, b, c, d]);

// Exercise the accepted reducer protocol before extending the public type.
function visit(state: WorkbenchLayoutState, action: WorkbenchAction, visitThreadId = 'A') {
  return reduceWorkbench(state, { ...action, visitThreadId } as WorkbenchAction);
}
function activate(state: WorkbenchLayoutState, surfaceId: string, thread = 'A') {
  return visit(state, { type: 'activate-surface', surfaceId, entitlement: user }, thread);
}
function recent(state: WorkbenchLayoutState, thread = 'A') {
  return (
    (state as WorkbenchLayoutState & { recentSurfaceIdsByThread?: Record<string, string[]> })
      .recentSurfaceIdsByThread?.[thread] ?? []
  );
}

afterEach(() => localStorage.removeItem(WORKBENCH_STORAGE_KEY));

describe('canonical per-thread recent visits', () => {
  it('maps a retained closed legacy file to the reopened canonical page in all threads without promoting passive visits', () => {
    const legacy = createLegacyFileSurface({ worktreeId: 'work', path: 'docs/a.md' });
    const canonical = createFileSurface({ worktreeId: 'work', path: 'docs/a.md' });
    let state = activate(createInitialWorkbenchState([legacy, b]), legacy.id, 'A');
    state = activate(state, legacy.id, 'B');
    state = activate(state, b.id, 'B');
    state = reduceWorkbench(state, { type: 'close-surface', surfaceId: legacy.id, entitlement: user });
    state = visit(state, { type: 'open-surface', surface: canonical, entitlement: user });
    expect(selectRecentSurfaces(state, 'A').map((surface) => surface.id)).toEqual([canonical.id]);
    expect(recent(state, 'B')).toEqual([b.id, canonical.id]);
    const hydrated = restoreWorkbenchState({
      ...state,
      recentSurfaceIdsByThread: { A: [legacy.id, canonical.id, b.id] },
    });
    expect(recent(hydrated)).toEqual([canonical.id, b.id]);
    expect(hydrated.surfaces).toEqual(state.surfaces);
    const closedAgain = reduceWorkbench(state, { type: 'close-surface', surfaceId: canonical.id, entitlement: user });
    const closedAliases = restoreWorkbenchState({
      ...closedAgain,
      recentSurfaceIdsByThread: { A: [canonical.id, legacy.id, b.id] },
    });
    expect(recent(closedAliases)).toEqual([canonical.id, b.id]);
  });

  it('does not collapse different paths behind a legacy root ID or the same path in different roots', () => {
    const legacy = createLegacyFileSurface({ worktreeId: 'work', path: 'docs/a.md' });
    const otherPath = createLegacyFileSurface({ worktreeId: 'work', path: 'docs/b.md' });
    const otherRoot = createFileSurface({ worktreeId: 'other', path: 'docs/a.md' });
    let state = activate(createInitialWorkbenchState([legacy]), legacy.id);
    state = reduceWorkbench(state, { type: 'close-surface', surfaceId: legacy.id, entitlement: user });
    state = visit(state, { type: 'open-surface', surface: otherPath, entitlement: user });
    state = visit(state, { type: 'open-surface', surface: otherRoot, entitlement: user });
    expect(selectRecentSurfaces(state, 'A')).toEqual([otherRoot, otherPath]);
  });
  it('projects only actually visited full descriptors, with live identity taking priority', () => {
    expect(selectRecentSurfaces(initial(), 'A')).toEqual([]);
    const state = {
      ...activate(initial(), a.id),
      recentlyClosed: [{ ...a, title: 'stale closed alias' }],
    };
    expect(selectRecentSurfaces(state, 'A')).toEqual([a]);
    expect(selectRecentSurfaces(state, 'B')).toEqual([]);
    const closed = reduceWorkbench(state, { type: 'close-surface', surfaceId: a.id, entitlement: user });
    expect(selectRecentSurfaces(closed, 'A')).toEqual([a]);
  });

  it('does not interpret a plain close fallback as a successful Back visit', () => {
    const state = activate(initial(), b.id);
    const closed = visit(
      state,
      {
        type: 'close-artifact-to-return',
        artifactSurfaceId: b.id,
        entitlement: { kind: 'user', reason: 'return-origin' },
      },
      'B',
    );
    expect(recent(closed, 'B')).toEqual([]);
    const fallback = visit(
      state,
      {
        type: 'close-surface',
        surfaceId: b.id,
        entitlement: { kind: 'user', reason: 'return-origin' },
      },
      'B',
    );
    expect(recent(fallback, 'B')).toEqual([]);
  });

  it('preserves exact thread IDs without inheriting prototype properties', () => {
    const state = activate(initial(), a.id, 'constructor');
    expect(selectRecentSurfaces(state, 'constructor')).toEqual([a]);
    expect(selectRecentSurfaces(initial(), '__proto__')).toEqual([]);
    const other = activate(state, b.id, '__proto__');
    expect(selectRecentSurfaces(other, '__proto__')).toEqual([b]);
    expect(recent(other, 'constructor')).toEqual([a.id]);
  });
  it('records actual access order separately from tab order, bounded to three', () => {
    let state = activate(initial(), c.id);
    state = activate(state, a.id);
    state = activate(state, d.id);
    state = activate(state, b.id);
    expect(recent(state)).toEqual([b.id, d.id, a.id]);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(activate(state, b.id)).toMatchObject({ recentSurfaceIdsByThread: { A: [b.id, d.id, a.id] } });
  });

  it('isolates host threads and does not count automatic foreground or lock projection', () => {
    let state = activate(initial(), a.id, 'A');
    state = activate(state, b.id, 'B');
    state = reduceWorkbench(state, {
      type: 'activate-surface',
      surfaceId: a.id,
      entitlement: { kind: 'user', reason: 'return-origin' },
    });
    expect(recent(state, 'A')).toEqual([a.id]);
    expect(recent(state, 'B')).toEqual([b.id]);
    state = activate(state, a.id, 'B');
    expect(recent(state, 'B')).toEqual([a.id, b.id]);
  });

  it('does not count rejected/background actions or layout changes even with a visit context', () => {
    const seed = activate(initial(), b.id);
    const background = { kind: 'background', reason: 'owner-background' } as const;
    const actions: WorkbenchAction[] = [
      { type: 'activate-surface', surfaceId: 'missing', entitlement: user },
      { type: 'restore-surface', surfaceId: 'missing', entitlement: user },
      { type: 'activate-surface', surfaceId: a.id, entitlement: background },
      { type: 'open-surface', surface: a, entitlement: background },
      { type: 'open-preview-surface', surface: a, entitlement: background },
      { type: 'pin-surface', surfaceId: a.id, pinned: true, entitlement: user },
      { type: 'reorder-surface', surfaceId: a.id, toIndex: 1, entitlement: user },
      { type: 'split-with', surfaceId: a.id, entitlement: user },
      { type: 'refresh-surface', surface: a },
    ];
    for (const action of actions) expect(recent(visit(seed, action))).toEqual([b.id]);
    for (const thread of ['', 'bad\0thread', 'x'.repeat(257)]) {
      expect(recent(activate(seed, a.id, thread))).toEqual([b.id]);
    }
  });

  it('records the retained preview identity, including a same-active explicit reselect', () => {
    const alias = { ...a, id: 'legacy-file', objectRef: { ...a.objectRef } };
    const state = visit(createInitialWorkbenchState([alias, b]), {
      type: 'open-preview-surface',
      surface: a,
      entitlement: user,
    });
    expect(state.activeSurfaceId).toBe(alias.id);
    expect(recent(state)).toEqual([alias.id]);
    expect(recent(activate(state, alias.id, 'B'), 'B')).toEqual([alias.id]);
  });

  it('remaps aliases on resolution without inventing a new visit or changing the newer position', () => {
    const source = createMessagePublicationSurface(
      {
        kind: 'message',
        threadId: 'source-thread',
        messageId: 'message',
        messageRevision: '1',
        expectedUrl: '/uploads/a.md',
        item: { kind: 'rich-file', blockId: 'block' },
      },
      'A',
    );
    let state = activate(createInitialWorkbenchState([source, a, b]), source.id);
    state = activate(state, b.id);
    state = activate(state, a.id);
    state = activate(state, source.id, 'B');
    const resolved = reduceWorkbench(state, {
      type: 'resolve-content-surface',
      sourceSurfaceId: source.id,
      surface: a,
    });
    expect(recent(resolved)).toEqual([a.id, b.id]);
    expect(recent(resolved, 'B')).toEqual([a.id]);
    expect(
      recent(reduceWorkbench(resolved, { type: 'resolve-content-surface', sourceSurfaceId: 'missing', surface: c })),
    ).toEqual([a.id, b.id]);
  });

  it('remaps a same-object replacement in every host thread without promoting passive resolution', () => {
    let state = activate(initial(), a.id);
    state = activate(state, a.id, 'B');
    state = activate(state, b.id);
    const rekeyed = { ...a, id: 'new-a' };
    state = reduceWorkbench(state, { type: 'open-surface', surface: rekeyed, entitlement: user });
    expect(recent(state)).toEqual([b.id, rekeyed.id]);
    expect(recent(state, 'B')).toEqual([rekeyed.id]);
  });

  it('keeps closing order independent and counts only successful explicit restore', () => {
    let state = activate(initial(), a.id);
    state = activate(state, b.id);
    state = visit(state, { type: 'close-surface', surfaceId: b.id, entitlement: user });
    expect(recent(state)).toEqual([b.id, a.id]);
    state = visit(state, { type: 'restore-surface', surfaceId: b.id, entitlement: user }, 'B');
    expect(recent(state, 'B')).toEqual([b.id]);
    expect(state.activeSurfaceId).toBe(b.id);
  });

  it('retains a replaced preview while closed, then drops released ghosts at the original limit', () => {
    let state = visit(createInitialWorkbenchState(), { type: 'open-preview-surface', surface: a, entitlement: user });
    state = visit(state, { type: 'open-preview-surface', surface: b, entitlement: user });
    expect(recent(state)).toEqual([b.id, a.id]);
    for (let i = 0; i < 6; i++) {
      const surface = createFileSurface({ worktreeId: 'work', path: `extra-${i}.md` });
      state = reduceWorkbench(state, { type: 'open-surface', surface, entitlement: user });
      state = reduceWorkbench(state, { type: 'close-surface', surfaceId: surface.id, entitlement: user });
    }
    expect(state.recentlyClosed).toHaveLength(5);
    expect(recent(state)).toEqual([b.id]);
  });

  it('does not visit a background sidecar, but records a promotion that actually takes foreground', () => {
    const state = visit(activate(createInitialWorkbenchState([a]), a.id), {
      type: 'open-sidecar',
      surface: b,
      entitlement: user,
    });
    expect(recent(state)).toEqual([a.id]);
    expect(recent(visit(state, { type: 'promote-sidecar', destination: 'split', entitlement: user }))).toEqual([a.id]);
    expect(recent(visit(state, { type: 'promote-sidecar', destination: 'tab', entitlement: user }))).toEqual([
      b.id,
      a.id,
    ]);
  });

  it('persists visits with original layout TTL0, admits descriptors first and keeps topology on corrupt MRU', () => {
    let state = activate(initial(), c.id);
    state = activate(state, a.id);
    writeWorkbenchState(localStorage, state);
    const restored = loadWorkbenchState({
      storage: localStorage,
      isOwnerRefAvailable: isRealSurfaceOwnerAvailable,
    }).layout;
    expect(recent(restored)).toEqual([a.id, c.id]);
    expect(JSON.parse(localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? '{}')).not.toHaveProperty('expiresAt');
    expect(
      recent(restoreWorkbenchState({ ...state, recentSurfaceIdsByThread: { A: [a.id, a.id, 'missing', c.id] } })),
    ).toEqual([a.id, c.id]);
    const unavailable = restoreWorkbenchState(state, { isOwnerRefAvailable: (surface) => surface.id !== a.id });
    expect(recent(unavailable)).toEqual([c.id]);
    for (const corrupt of [undefined, null, 'bad', { A: 'bad' }, { A: [null, 1, 'missing'] }]) {
      const valid = restoreWorkbenchState({ ...state, recentSurfaceIdsByThread: corrupt });
      expect(valid.surfaces).toEqual(state.surfaces);
      expect(recent(valid)).toEqual([]);
    }
  });

  it('keeps a publication resolution in its original visit position rather than newest', () => {
    const source = createMessagePublicationSurface(
      {
        kind: 'message',
        threadId: 'source',
        messageId: 'message',
        messageRevision: '1',
        expectedUrl: '/uploads/a.png',
        item: { kind: 'content-block', index: 0 },
      },
      'image',
    );
    const target = createPublicationSurface({
      contentRef: `prepared-media:${'a'.repeat(64)}`,
      ownerRevision: 1,
      title: 'image',
    });
    let state = activate(createInitialWorkbenchState([source, a]), source.id);
    state = activate(state, a.id);
    state = reduceWorkbench(state, { type: 'resolve-content-surface', sourceSurfaceId: source.id, surface: target });
    expect(recent(state)).toEqual([a.id, target.id]);
  });
});
