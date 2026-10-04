import { describe, expect, it } from 'vitest';

import {
  acceptWorldDirectory,
  parseCollectiveWorldTarget,
  resolveExplicitWorldTarget,
  type WorldDirectoryGeneration,
  worldDirectoryServiceMismatch,
} from '../collective-world-directory';

const generation: WorldDirectoryGeneration = {
  bridgeId: 'bridge_12345678',
  revision: 0,
  serviceOrigin: 'http://localhost:5201',
  expectedServiceInstanceId: 'svc_12345678',
};

const directory = {
  type: 'collective:client-world-directory' as const,
  bridgeId: generation.bridgeId,
  revision: 1,
  state: 'ready' as const,
  serviceInstanceId: 'svc_12345678',
  humanId: 'human_12345678',
  currentCollectiveId: 'col_12345678',
  memberships: [
    { collectiveId: 'col_12345678', name: 'Alpha', role: 'steward' as const },
    { collectiveId: 'col_87654321', name: 'Invite-only room', role: 'member' as const },
  ],
};

describe('Host Collective world directory', () => {
  it('accepts only the current iframe origin, bridge generation, Service identity and newer revision', () => {
    expect(
      acceptWorldDirectory({
        data: directory,
        eventOrigin: generation.serviceOrigin,
        sourceMatches: true,
        generation,
      }),
    ).toEqual(directory);
    expect(
      acceptWorldDirectory({
        data: directory,
        eventOrigin: 'http://malicious.invalid',
        sourceMatches: true,
        generation,
      }),
    ).toBeUndefined();
    expect(
      acceptWorldDirectory({
        data: { ...directory, bridgeId: 'bridge_stale000' },
        eventOrigin: generation.serviceOrigin,
        sourceMatches: true,
        generation,
      }),
    ).toBeUndefined();
    expect(
      acceptWorldDirectory({
        data: { ...directory, serviceInstanceId: 'svc_wrong0000' },
        eventOrigin: generation.serviceOrigin,
        sourceMatches: true,
        generation,
      }),
    ).toBeUndefined();
    expect(
      worldDirectoryServiceMismatch({
        data: { ...directory, serviceInstanceId: 'svc_wrong0000' },
        eventOrigin: generation.serviceOrigin,
        sourceMatches: true,
        generation,
      }),
    ).toBe(true);
    expect(
      acceptWorldDirectory({
        data: { ...directory, revision: 0 },
        eventOrigin: generation.serviceOrigin,
        sourceMatches: true,
        generation,
      }),
    ).toBeUndefined();
    expect(
      acceptWorldDirectory({
        data: { ...directory, revision: 2, humanId: 'human_other000' },
        eventOrigin: generation.serviceOrigin,
        sourceMatches: true,
        generation: { ...generation, revision: 1, humanId: directory.humanId },
      }),
    ).toBeUndefined();
  });

  it('does not fall back to another world when an explicit target is absent or revoked', () => {
    expect(
      resolveExplicitWorldTarget(directory, {
        serviceInstanceId: 'svc_12345678',
        collectiveId: 'col_87654321',
      }),
    ).toMatchObject({ kind: 'selected', membership: { collectiveId: 'col_87654321' } });
    expect(
      resolveExplicitWorldTarget(directory, {
        serviceInstanceId: 'svc_12345678',
        collectiveId: 'col_missing00',
      }),
    ).toEqual({ kind: 'missing_membership' });
    expect(
      resolveExplicitWorldTarget(directory, {
        serviceInstanceId: 'svc_wrong0000',
        collectiveId: 'col_12345678',
      }),
    ).toEqual({ kind: 'service_mismatch' });
  });

  it('parses only complete explicit Host world targets and preserves invalid intent as invalid', () => {
    expect(
      parseCollectiveWorldTarget(
        '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_12345678&collectiveId=col_87654321',
      ),
    ).toEqual({
      kind: 'target',
      target: {
        serviceUrl: 'http://localhost:5201',
        serviceInstanceId: 'svc_12345678',
        collectiveId: 'col_87654321',
      },
    });
    expect(parseCollectiveWorldTarget('/collective')).toEqual({ kind: 'none' });
    expect(parseCollectiveWorldTarget('/collective?collectiveId=col_87654321')).toEqual({ kind: 'invalid' });
    expect(
      parseCollectiveWorldTarget(
        '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_12345678&collectiveId=col_87654321&fallback=first',
      ),
    ).toEqual({ kind: 'invalid' });
  });
});
