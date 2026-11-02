import type { CollectiveClientWorldDirectory } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectWorldRailDirectory } from '../../shell/use-world-rail-entries';
import {
  beginWorldDirectoryObservation,
  endWorldDirectoryObservation,
  failWorldDirectoryObservation,
  getWorldDirectoryStoreSnapshot,
  publishWorldDirectoryObservation,
  recoverWorldDirectoryCache,
  resetWorldDirectoryStoreForTests,
} from '../collective-world-directory-store';

function readyDirectory({
  bridgeId,
  revision = 1,
  serviceInstanceId = 'svc_aaaaaaaa',
  humanId = 'human_aaaaaaaa',
  currentCollectiveId,
  memberships = [],
}: {
  bridgeId: string;
  revision?: number;
  serviceInstanceId?: string;
  humanId?: string;
  currentCollectiveId?: string;
  memberships?: readonly { collectiveId: string; name: string; role: 'steward' | 'member' }[];
}): CollectiveClientWorldDirectory {
  return {
    type: 'collective:client-world-directory',
    bridgeId,
    revision,
    state: 'ready',
    serviceInstanceId,
    humanId,
    ...(currentCollectiveId ? { currentCollectiveId } : {}),
    memberships: [...memberships],
  };
}

describe('shared Collective world-directory projection', () => {
  beforeEach(resetWorldDirectoryStoreForTests);

  it('retains names only as checking between frame generations and ignores stale publishers', () => {
    beginWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      expectedServiceInstanceId: 'svc_aaaaaaaa',
    });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        currentCollectiveId: 'col_aaaaaaaa',
        memberships: [
          { collectiveId: 'col_aaaaaaaa', name: '猫咖共创组', role: 'steward' },
          { collectiveId: 'col_aaaaaaaa', name: '重复连接不重复世界', role: 'member' },
        ],
      }),
    });

    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      status: 'ready',
      humanId: 'human_aaaaaaaa',
      currentCollectiveId: 'col_aaaaaaaa',
      memberships: [{ collectiveId: 'col_aaaaaaaa', name: '猫咖共创组' }],
    });

    beginWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_bbbbbbbb',
      expectedServiceInstanceId: 'svc_aaaaaaaa',
    });
    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      bridgeId: 'bridge_bbbbbbbb',
      status: 'checking',
      memberships: [{ collectiveId: 'col_aaaaaaaa', name: '猫咖共创组' }],
    });

    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        revision: 2,
        memberships: [{ collectiveId: 'col_stale000', name: '旧账号世界', role: 'member' }],
      }),
    });
    expect(getWorldDirectoryStoreSnapshot().services[0]?.memberships.map((item) => item.name)).toEqual(['猫咖共创组']);

    endWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_aaaaaaaa' });
    expect(getWorldDirectoryStoreSnapshot().services[0]?.status).toBe('checking');
  });

  it('replaces the same Service on Human change and clears membership names when login is no longer valid', () => {
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_aaaaaaaa' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        memberships: [{ collectiveId: 'col_aaaaaaaa', name: '账号 A 的世界', role: 'member' }],
      }),
    });
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_bbbbbbbb' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_bbbbbbbb',
      directory: readyDirectory({
        bridgeId: 'bridge_bbbbbbbb',
        humanId: 'human_bbbbbbbb',
        memberships: [{ collectiveId: 'col_bbbbbbbb', name: '账号 B 的世界', role: 'member' }],
      }),
    });
    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      humanId: 'human_bbbbbbbb',
      memberships: [{ collectiveId: 'col_bbbbbbbb', name: '账号 B 的世界' }],
    });

    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_cccccccc' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_cccccccc',
      directory: {
        type: 'collective:client-world-directory',
        bridgeId: 'bridge_cccccccc',
        revision: 1,
        state: 'session_required',
        serviceInstanceId: 'svc_aaaaaaaa',
      },
    });
    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      status: 'session_required',
      memberships: [],
    });
    expect(getWorldDirectoryStoreSnapshot().services[0]?.humanId).toBeUndefined();
  });

  it('keeps the current Human names only as non-active refresh context when the Service becomes unavailable', () => {
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_aaaaaaaa' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        currentCollectiveId: 'col_aaaaaaaa',
        memberships: [{ collectiveId: 'col_aaaaaaaa', name: '账号 A 的世界', role: 'member' }],
      }),
    });

    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_bbbbbbbb' });
    const checking = getWorldDirectoryStoreSnapshot();
    expect(checking.services[0]).toMatchObject({
      status: 'checking',
      humanId: 'human_aaaaaaaa',
      memberships: [{ name: '账号 A 的世界' }],
    });
    expect(projectWorldRailDirectory(checking).worlds.some((world) => world.active)).toBe(false);

    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_bbbbbbbb',
      directory: {
        type: 'collective:client-world-directory',
        bridgeId: 'bridge_bbbbbbbb',
        revision: 1,
        state: 'unavailable',
        code: 'service_unavailable',
        serviceInstanceId: 'svc_aaaaaaaa',
      },
    });
    const unavailable = getWorldDirectoryStoreSnapshot();
    expect(unavailable.services[0]).toMatchObject({
      status: 'unavailable',
      humanId: 'human_aaaaaaaa',
      memberships: [{ name: '账号 A 的世界' }],
    });
    expect(projectWorldRailDirectory(unavailable).worlds).toMatchObject([{ active: false, status: 'unavailable' }]);
  });

  it('drops cached worlds on a verified Service identity mismatch', () => {
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_aaaaaaaa' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        memberships: [{ collectiveId: 'col_aaaaaaaa', name: '不能残留', role: 'member' }],
      }),
    });
    failWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      failure: 'service_mismatch',
    });
    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      status: 'service_mismatch',
      memberships: [],
    });
  });

  it('recovers a persisted verified Human directory only as checking when connector authority still matches', () => {
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_aaaaaaaa' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        memberships: [
          { collectiveId: 'col_aaaaaaaa', name: '刷新后仍可见', role: 'steward' },
          { collectiveId: 'col_bbbbbbbb', name: '另一个共同体', role: 'member' },
        ],
      }),
    });

    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([
      {
        serviceUrl: 'http://localhost:5201',
        serviceInstanceId: 'svc_aaaaaaaa',
        authorizedHumanId: 'human_aaaaaaaa',
        authorityStatus: 'connected',
      },
    ]);

    expect(getWorldDirectoryStoreSnapshot().services).toMatchObject([
      {
        status: 'checking',
        serviceInstanceId: 'svc_aaaaaaaa',
        humanId: 'human_aaaaaaaa',
        currentCollectiveId: undefined,
        memberships: [{ name: '刷新后仍可见' }, { name: '另一个共同体' }],
      },
    ]);
    expect(projectWorldRailDirectory(getWorldDirectoryStoreSnapshot()).worlds).toMatchObject([
      { name: '刷新后仍可见', status: 'checking', active: false },
      { name: '另一个共同体', status: 'checking', active: false },
    ]);
  });

  it('does not recover a verified directory for another Human and erases it after session loss', () => {
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_aaaaaaaa' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_aaaaaaaa',
      directory: readyDirectory({
        bridgeId: 'bridge_aaaaaaaa',
        memberships: [{ collectiveId: 'col_aaaaaaaa', name: '账号 A 的世界', role: 'member' }],
      }),
    });

    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([
      {
        serviceUrl: 'http://localhost:5201',
        serviceInstanceId: 'svc_aaaaaaaa',
        authorizedHumanId: 'human_bbbbbbbb',
        authorityStatus: 'connected',
      },
    ]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);

    recoverWorldDirectoryCache([
      {
        serviceUrl: 'http://localhost:5201',
        serviceInstanceId: 'svc_aaaaaaaa',
        authorizedHumanId: 'human_aaaaaaaa',
        authorityStatus: 'connected',
      },
    ]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);
    beginWorldDirectoryObservation({ serviceUrl: 'http://localhost:5201', bridgeId: 'bridge_bbbbbbbb' });
    publishWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_bbbbbbbb',
      directory: {
        type: 'collective:client-world-directory',
        bridgeId: 'bridge_bbbbbbbb',
        revision: 1,
        state: 'session_required',
        serviceInstanceId: 'svc_aaaaaaaa',
      },
    });
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([
      {
        serviceUrl: 'http://localhost:5201',
        serviceInstanceId: 'svc_aaaaaaaa',
        authorizedHumanId: 'human_aaaaaaaa',
        authorityStatus: 'connected',
      },
    ]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);
  });

  it('rejects tampered persisted coordinates instead of turning browser storage into world links', () => {
    window.localStorage.setItem(
      'cat-cafe:collective-world-directory:v1',
      JSON.stringify({
        version: 1,
        services: [
          {
            serviceUrl: 'http://localhost:5201',
            serviceInstanceId: 'not-a-service',
            humanId: 'human_aaaaaaaa',
            memberships: [{ collectiveId: '../settings', name: '伪造入口', role: 'member' }],
          },
        ],
      }),
    );

    recoverWorldDirectoryCache([
      {
        serviceUrl: 'http://localhost:5201',
        serviceInstanceId: 'not-a-service',
        authorizedHumanId: 'human_aaaaaaaa',
        authorityStatus: 'connected',
      },
    ]);

    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);
  });

  it('deduplicates two endpoints for one Service world without merging same-named worlds across Services', () => {
    for (const [serviceUrl, bridgeId, serviceInstanceId, collectiveId] of [
      ['http://localhost:5201', 'bridge_aaaaaaaa', 'svc_aaaaaaaa', 'col_aaaaaaaa'],
      ['https://same-service.example', 'bridge_bbbbbbbb', 'svc_aaaaaaaa', 'col_aaaaaaaa'],
      ['https://another-service.example', 'bridge_cccccccc', 'svc_bbbbbbbb', 'col_bbbbbbbb'],
    ] as const) {
      beginWorldDirectoryObservation({ serviceUrl, bridgeId, expectedServiceInstanceId: serviceInstanceId });
      publishWorldDirectoryObservation({
        serviceUrl,
        bridgeId,
        directory: readyDirectory({
          bridgeId,
          serviceInstanceId,
          memberships: [{ collectiveId, name: '同名世界', role: 'member' }],
        }),
      });
    }

    const directory = projectWorldRailDirectory(getWorldDirectoryStoreSnapshot());
    expect(directory.worlds).toHaveLength(2);
    expect(directory.worlds.map((world) => world.key)).toEqual([
      'svc_aaaaaaaa:col_aaaaaaaa',
      'svc_bbbbbbbb:col_bbbbbbbb',
    ]);
  });
});
