import { describe, expect, it } from 'vitest';

import type { ClientSnapshot } from '../client-types.js';
import {
  projectWorldDirectory,
  trustedWorldDirectoryHostMessage,
  worldSelectionMatches,
} from '../world-directory-bridge.js';

const readySnapshot: ClientSnapshot = {
  phase: 'ready',
  meta: {
    serviceInstanceId: 'svc_12345678',
    bootstrapNeeded: false,
    onboardingComplete: true,
    clientBuildId: 'build-1',
  },
  me: {
    human: { humanId: 'human_12345678', displayName: 'You', createdAt: '2026-09-27T00:00:00.000Z' },
    auth: { provider: 'github', handle: 'operator' },
    collectives: [
      {
        collectiveId: 'col_12345678',
        name: 'Alpha',
        createdByHumanId: 'human_12345678',
        createdAt: '2026-09-27T00:00:00.000Z',
        role: 'steward',
      },
      {
        collectiveId: 'col_87654321',
        name: 'Invite-only room',
        createdByHumanId: 'human_87654321',
        createdAt: '2026-09-27T01:00:00.000Z',
        role: 'member',
      },
    ],
  },
  collective: {
    collectiveId: 'col_12345678',
    name: 'Alpha',
    createdByHumanId: 'human_12345678',
    createdAt: '2026-09-27T00:00:00.000Z',
    role: 'steward',
  },
  providers: [],
  events: [],
  connection: 'online',
  delivery: { kind: 'idle' },
};
const readyHuman = readySnapshot.me;
if (!readyHuman) throw new Error('Expected an authenticated Human fixture');

describe('Collective world-directory bridge', () => {
  it('projects all active memberships from the current Service-authenticated Human without private coordinates', () => {
    const directory = projectWorldDirectory(readySnapshot, 'bridge_12345678', 1);
    expect(directory).toMatchObject({
      state: 'ready',
      serviceInstanceId: 'svc_12345678',
      humanId: 'human_12345678',
      currentCollectiveId: 'col_12345678',
      memberships: [
        { collectiveId: 'col_12345678', name: 'Alpha', role: 'steward' },
        { collectiveId: 'col_87654321', name: 'Invite-only room', role: 'member' },
      ],
    });
    expect(directory).not.toHaveProperty('sessionToken');
    expect(directory).not.toHaveProperty('privateThreadId');
  });

  it('distinguishes a missing session from a valid empty membership list', () => {
    const sessionRequired = projectWorldDirectory(
      { ...readySnapshot, phase: 'entry', me: undefined, collective: undefined },
      'bridge_12345678',
      1,
    );
    expect(sessionRequired).toMatchObject({ state: 'session_required', serviceInstanceId: 'svc_12345678' });

    const empty = projectWorldDirectory(
      {
        ...readySnapshot,
        phase: 'create-collective',
        me: { ...readyHuman, collectives: [] },
        collective: undefined,
      },
      'bridge_12345678',
      2,
    );
    expect(empty).toMatchObject({ state: 'ready', memberships: [] });
  });

  it('reports an offline Client as unavailable instead of replaying a cached ready directory', () => {
    expect(projectWorldDirectory({ ...readySnapshot, connection: 'offline' }, 'bridge_12345678', 1)).toMatchObject({
      state: 'unavailable',
      code: 'service_unavailable',
    });
  });

  it('accepts Host selection only for the exact directory generation, Human and membership', () => {
    const directory = projectWorldDirectory(readySnapshot, 'bridge_12345678', 3);
    if (!directory || directory.state !== 'ready') throw new Error('expected ready directory');
    const selection = {
      type: 'collective:host-select-world' as const,
      bridgeId: directory.bridgeId,
      directoryRevision: directory.revision,
      serviceInstanceId: directory.serviceInstanceId,
      humanId: directory.humanId,
      collectiveId: 'col_87654321',
    };
    expect(worldSelectionMatches(selection, directory)).toBe(true);
    expect(worldSelectionMatches({ ...selection, directoryRevision: 2 }, directory)).toBe(false);
    expect(worldSelectionMatches({ ...selection, humanId: 'human_other000' }, directory)).toBe(false);
    expect(worldSelectionMatches({ ...selection, collectiveId: 'col_missing00' }, directory)).toBe(false);
  });

  it('accepts init and selection messages only from the exact Host parent and origin', () => {
    const parent = {};
    const init = { type: 'collective:host-world-directory-init', bridgeId: 'bridge_12345678' };
    expect(
      trustedWorldDirectoryHostMessage(
        { origin: 'http://localhost:3000', source: parent, data: init },
        'http://localhost:3000',
        parent,
      ),
    ).toEqual(init);
    expect(
      trustedWorldDirectoryHostMessage(
        { origin: 'http://malicious.invalid', source: parent, data: init },
        'http://localhost:3000',
        parent,
      ),
    ).toBeUndefined();
    expect(
      trustedWorldDirectoryHostMessage(
        { origin: 'http://localhost:3000', source: {}, data: init },
        'http://localhost:3000',
        parent,
      ),
    ).toBeUndefined();
  });
});
