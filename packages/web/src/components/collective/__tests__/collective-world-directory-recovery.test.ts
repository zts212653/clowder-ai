import type { CollectiveClientWorldDirectory } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginWorldDirectoryObservation,
  failWorldDirectoryObservation,
  getWorldDirectoryStoreSnapshot,
  publishWorldDirectoryObservation,
  recoverWorldDirectoryCache,
  resetWorldDirectoryStoreForTests,
  type WorldDirectoryRecoveryAuthority,
} from '../collective-world-directory-store';

const SERVICE_URL = 'http://localhost:5201';
const CACHE_KEY = 'cat-cafe:collective-world-directory:v1';

function recoveryAuthority(overrides: Partial<WorldDirectoryRecoveryAuthority> = {}): WorldDirectoryRecoveryAuthority {
  return {
    serviceUrl: SERVICE_URL,
    serviceInstanceId: 'svc_aaaaaaaa',
    authorizedHumanId: 'human_aaaaaaaa',
    authorityStatus: 'connected',
    ...overrides,
  };
}

function seedRecoverableDirectory(): void {
  beginWorldDirectoryObservation({ serviceUrl: SERVICE_URL, bridgeId: 'bridge_aaaaaaaa' });
  publishWorldDirectoryObservation({
    serviceUrl: SERVICE_URL,
    bridgeId: 'bridge_aaaaaaaa',
    directory: {
      type: 'collective:client-world-directory',
      bridgeId: 'bridge_aaaaaaaa',
      revision: 1,
      state: 'ready',
      serviceInstanceId: 'svc_aaaaaaaa',
      humanId: 'human_aaaaaaaa',
      currentCollectiveId: 'col_aaaaaaaa',
      memberships: [{ collectiveId: 'col_aaaaaaaa', name: '缓存里的世界', role: 'member' }],
    } satisfies CollectiveClientWorldDirectory,
  });
}

function capturePersistedDirectory(): string {
  const value = window.localStorage.getItem(CACHE_KEY);
  if (value === null) throw new Error('Expected a persisted directory fixture');
  return value;
}

describe('persisted world-directory recovery fences', () => {
  beforeEach(resetWorldDirectoryStoreForTests);

  it('does not recover or retain cached names after connector authority is revoked', () => {
    seedRecoverableDirectory();
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([recoveryAuthority({ authorityStatus: 'revoked' })]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);

    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([recoveryAuthority()]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);
  });

  it('does not recover cached names for a replacement Service at the same origin', () => {
    seedRecoverableDirectory();
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([recoveryAuthority({ serviceInstanceId: 'svc_bbbbbbbb' })]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);

    resetWorldDirectoryStoreForTests({ preserveCache: true });
    recoverWorldDirectoryCache([recoveryAuthority()]);
    expect(getWorldDirectoryStoreSnapshot().services).toEqual([]);
  });

  it('keeps a live unavailable result while restoring its missing display names from cache', () => {
    seedRecoverableDirectory();
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    beginWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_bbbbbbbb',
      expectedServiceInstanceId: 'svc_aaaaaaaa',
    });
    publishWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
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

    recoverWorldDirectoryCache([recoveryAuthority()]);

    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      bridgeId: 'bridge_bbbbbbbb',
      revision: 1,
      status: 'unavailable',
      memberships: [{ name: '缓存里的世界' }],
    });
  });

  it('does not let late cache recovery replace a live ready result', () => {
    seedRecoverableDirectory();
    const staleCache = capturePersistedDirectory();
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    beginWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_bbbbbbbb',
      expectedServiceInstanceId: 'svc_aaaaaaaa',
    });
    publishWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_bbbbbbbb',
      directory: {
        type: 'collective:client-world-directory',
        bridgeId: 'bridge_bbbbbbbb',
        revision: 1,
        state: 'ready',
        serviceInstanceId: 'svc_aaaaaaaa',
        humanId: 'human_aaaaaaaa',
        memberships: [{ collectiveId: 'col_bbbbbbbb', name: '实时目录', role: 'steward' }],
      },
    });
    window.localStorage.setItem(CACHE_KEY, staleCache);

    recoverWorldDirectoryCache([recoveryAuthority()]);

    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      bridgeId: 'bridge_bbbbbbbb',
      revision: 1,
      status: 'ready',
      memberships: [{ name: '实时目录' }],
    });
  });

  it('does not resurrect cached names after live session loss or Service mismatch', () => {
    seedRecoverableDirectory();
    const staleCache = capturePersistedDirectory();
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    beginWorldDirectoryObservation({ serviceUrl: SERVICE_URL, bridgeId: 'bridge_bbbbbbbb' });
    publishWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_bbbbbbbb',
      directory: {
        type: 'collective:client-world-directory',
        bridgeId: 'bridge_bbbbbbbb',
        revision: 1,
        state: 'session_required',
        serviceInstanceId: 'svc_aaaaaaaa',
      },
    });
    window.localStorage.setItem(CACHE_KEY, staleCache);
    recoverWorldDirectoryCache([recoveryAuthority()]);
    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      status: 'session_required',
      memberships: [],
    });

    resetWorldDirectoryStoreForTests();
    window.localStorage.setItem(CACHE_KEY, staleCache);
    beginWorldDirectoryObservation({ serviceUrl: SERVICE_URL, bridgeId: 'bridge_cccccccc' });
    failWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_cccccccc',
      failure: 'service_mismatch',
    });
    window.localStorage.setItem(CACHE_KEY, staleCache);
    recoverWorldDirectoryCache([recoveryAuthority()]);
    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      status: 'service_mismatch',
      memberships: [],
    });
  });

  it('does not add cached names to an unavailable frame for another expected Service', () => {
    seedRecoverableDirectory();
    resetWorldDirectoryStoreForTests({ preserveCache: true });
    beginWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_bbbbbbbb',
      expectedServiceInstanceId: 'svc_bbbbbbbb',
    });
    publishWorldDirectoryObservation({
      serviceUrl: SERVICE_URL,
      bridgeId: 'bridge_bbbbbbbb',
      directory: {
        type: 'collective:client-world-directory',
        bridgeId: 'bridge_bbbbbbbb',
        revision: 1,
        state: 'unavailable',
        code: 'client_unavailable',
      },
    });

    recoverWorldDirectoryCache([recoveryAuthority()]);

    expect(getWorldDirectoryStoreSnapshot().services[0]).toMatchObject({
      expectedServiceInstanceId: 'svc_bbbbbbbb',
      status: 'unavailable',
      memberships: [],
    });
  });
});
