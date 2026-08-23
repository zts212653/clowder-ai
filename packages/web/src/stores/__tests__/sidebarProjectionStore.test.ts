import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSaveSidebarSnapshot = vi.fn((rows: unknown) => {
  void rows;
  return Promise.resolve();
});

vi.mock('@/utils/offline-store', () => ({
  saveSidebarSnapshot: (rows: unknown) => mockSaveSidebarSnapshot(rows),
}));

import {
  parseSidebarSnapshotRows,
  projectSidebarRows,
  type SidebarSnapshotRow,
  useSidebarProjectionStore,
} from '@/stores/sidebarProjectionStore';

function row(id: string, patch: Partial<SidebarSnapshotRow> = {}): SidebarSnapshotRow {
  return {
    id,
    title: id,
    participants: [],
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: 'default',
    lastActiveAt: 1,
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...patch,
  };
}

describe('sidebarProjectionStore authority boundary', () => {
  beforeEach(() => {
    mockSaveSidebarSnapshot.mockClear();
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
  });

  it('accepts cache only before canonical apply and rejects late cache', () => {
    const store = useSidebarProjectionStore.getState();

    expect(store.applySidebarSnapshot([row('cached')], 0, { source: 'cache' })).toBe(true);
    expect(useSidebarProjectionStore.getState().rows.map((entry) => entry.id)).toEqual(['cached']);

    expect(store.applySidebarSnapshot([row('server')], 1)).toBe(true);
    expect(store.applySidebarSnapshot([row('late-cache')], 0, { source: 'cache' })).toBe(false);
    expect(useSidebarProjectionStore.getState().rows.map((entry) => entry.id)).toEqual(['server']);
  });

  it('strips the wide server response to the C0-C10 runtime boundary', () => {
    const [parsed] = parseSidebarSnapshotRows([
      {
        ...row('thread-1'),
        pinnedAt: 10,
        favoritedAt: 11,
        connectorHubState: { connectorId: 'secret' },
        activeInvocations: { invocation: {} },
        messages: [{ content: 'not sidebar data' }],
        queue: [{ content: 'not sidebar data' }],
      },
    ]);

    expect(Object.keys(parsed).sort()).toEqual(
      [
        'favorited',
        'hasUserMention',
        'id',
        'isHubThread',
        'labels',
        'lastActiveAt',
        'participants',
        'pinned',
        'preferredCats',
        'presence',
        'projectPath',
        'systemKind',
        'title',
        'unreadCount',
      ].sort(),
    );
    expect(parsed.isHubThread).toBe(false);
  });

  it('preserves finite working activeSince and rejects malformed elapsed truth', () => {
    const [working, malformed] = parseSidebarSnapshotRows([
      { ...row('working'), presence: { status: 'working', cats: ['codex-sol'], activeSince: 1234 } },
      { ...row('malformed'), presence: { status: 'working', activeSince: 'yesterday' } },
    ]);

    expect(working.presence).toEqual({ status: 'working', cats: ['codex-sol'], activeSince: 1234 });
    expect(malformed.presence).toEqual({ status: 'working' });
  });

  it('rejects an older HTTP generation after a newer snapshot was applied', () => {
    const store = useSidebarProjectionStore.getState();

    expect(store.applySidebarSnapshot([row('newer')], 2)).toBe(true);
    expect(store.applySidebarSnapshot([row('older')], 1)).toBe(false);
    expect(useSidebarProjectionStore.getState().rows.map((entry) => entry.id)).toEqual(['newer']);
  });

  it('persists only accepted canonical snapshots from the canonical apply', () => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot([row('cached')], 0, { source: 'cache' });
    store.applySidebarSnapshot([row('server')], 1);
    store.applySidebarSnapshot([row('stale')], 1);

    expect(mockSaveSidebarSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveSidebarSnapshot).toHaveBeenCalledWith([row('server')]);
  });

  it('keeps canonical rows immutable while projecting and failing optimistic fields', () => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot([row('thread-1', { title: 'server title', pinned: false })], 1);
    const canonicalBefore = useSidebarProjectionStore.getState().rows;

    const titleCommand = store.beginSidebarCommand('thread-1', 'title', 'optimistic title');
    const pinCommand = store.beginSidebarCommand('thread-1', 'pinned', true);
    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]).toMatchObject({
      title: 'optimistic title',
      pinned: true,
    });
    expect(useSidebarProjectionStore.getState().rows).toBe(canonicalBefore);
    expect(useSidebarProjectionStore.getState().rows[0]).toMatchObject({ title: 'server title', pinned: false });

    store.failSidebarCommand(titleCommand);
    store.failSidebarCommand(pinCommand);
    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]).toMatchObject({
      title: 'server title',
      pinned: false,
    });
    expect(useSidebarProjectionStore.getState().rows).toBe(canonicalBefore);
  });

  it('retires a successful overlay only after a canonical snapshot observes its value', () => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot([row('thread-1', { pinned: false })], 1);
    store.beginSidebarCommand('thread-1', 'pinned', true);

    store.applySidebarSnapshot([row('thread-1', { pinned: false })], 2);
    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]?.pinned).toBe(true);

    store.applySidebarSnapshot([row('thread-1', { pinned: true })], 3);
    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]?.pinned).toBe(true);
    expect(useSidebarProjectionStore.getState().pendingThreadCommands).toEqual({});
  });

  it('reveals a newer canonical value when an older optimistic command fails', () => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot([row('thread-1', { title: 'server-before' })], 1);
    const commandId = store.beginSidebarCommand('thread-1', 'title', 'optimistic-title');

    store.applySidebarSnapshot([row('thread-1', { title: 'server-newer' })], 2);
    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]?.title).toBe('optimistic-title');

    store.failSidebarCommand(commandId);
    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]?.title).toBe('server-newer');
    expect(useSidebarProjectionStore.getState().rows[0]?.title).toBe('server-newer');
  });

  it('makes concurrent commands for the same field last-command-wins', () => {
    const store = useSidebarProjectionStore.getState();
    store.applySidebarSnapshot([row('thread-1', { pinned: false })], 1);

    const older = store.beginSidebarCommand('thread-1', 'pinned', true);
    store.beginSidebarCommand('thread-1', 'pinned', false);
    store.failSidebarCommand(older);

    expect(projectSidebarRows(useSidebarProjectionStore.getState())[0]?.pinned).toBe(false);
    expect(Object.keys(useSidebarProjectionStore.getState().pendingThreadCommands)).toHaveLength(1);
  });
});
