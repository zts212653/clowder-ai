import { describe, expect, it } from 'vitest';
import type {
  WorldDirectoryServiceSnapshot,
  WorldDirectoryStoreSnapshot,
} from '../../collective/collective-world-directory-store';
import { projectWorldRailDirectory } from '../use-world-rail-entries';

const memberships = [
  { collectiveId: 'col_aaaaaaaa', name: '一号共同体', role: 'member' as const },
  { collectiveId: 'col_bbbbbbbb', name: '二号共同体', role: 'member' as const },
];

function service(serviceUrl: string, overrides: Partial<WorldDirectoryServiceSnapshot>): WorldDirectoryServiceSnapshot {
  return {
    serviceUrl,
    serviceInstanceId: 'svc_aaaaaaaa',
    revision: 1,
    observation: 1,
    status: 'ready',
    memberships,
    ...overrides,
  };
}

function project(services: readonly WorldDirectoryServiceSnapshot[]) {
  const snapshot: WorldDirectoryStoreSnapshot = { version: 1, services };
  return projectWorldRailDirectory(snapshot);
}

describe('world rail directory projection', () => {
  it('takes the only active world from the live endpoint when a stale endpoint disagrees', () => {
    const directory = project([
      service('https://stale.example', {
        status: 'checking',
        observation: 3,
        currentCollectiveId: 'col_aaaaaaaa',
      }),
      service('https://live.example', {
        status: 'ready',
        observation: 6,
        currentCollectiveId: 'col_bbbbbbbb',
      }),
    ]);

    expect(directory.worlds.filter((world) => world.active).map((world) => world.key)).toEqual([
      'svc_aaaaaaaa:col_bbbbbbbb',
    ]);
    expect(directory.worlds.find((world) => world.collectiveId === 'col_aaaaaaaa')?.serviceUrl).toBe(
      'https://live.example',
    );
  });

  it('chooses the newest observation when duplicate endpoints have equal status rank', () => {
    const directory = project([
      service('https://first.example', { status: 'checking', observation: 3 }),
      service('https://latest.example', { status: 'checking', observation: 6 }),
    ]);

    expect(directory.worlds).toHaveLength(2);
    expect(directory.worlds[0]).toMatchObject({
      serviceUrl: 'https://latest.example',
      href: '/collective?serviceUrl=https%3A%2F%2Flatest.example&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_aaaaaaaa',
    });
  });
});
