import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { expect, it, vi } from 'vitest';
import { CollectiveClientRequestError } from '../client-request.js';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { resolveSharedArtifactModification } from '../shared-artifact-control-client.js';

function fixture() {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const artifact = { artifactId: 'artifact', sourceEventId: 'source' } as SharedArtifact;
  const record: CollectiveModificationProjection = {
    requestId: `f309-modification-${'a'.repeat(64)}`,
    revision: 2,
    state: 'proposal_ready',
    requestingHumanId: 'requester',
    annotationIds: ['note'],
    createdAt: 1,
    updatedAt: 2,
    target: { humanId: 'owner', catId: 'sol' },
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    requestEventId: 'request-source',
    sourceEventId: 'source',
    location: { channelId: 'general' },
    latestProposalRef: 'candidate',
  };
  const resolved = {
    ...record,
    state: 'cancelled',
    revision: 3,
    resolution: {
      kind: 'cancelled',
      actorHumanId: 'requester',
      receiptRef: 'owner-resolution',
      resolvedAt: 3,
    },
  };
  return { storage, artifact, record, resolved };
}

it('recovers a lost request-control response with the same operation and refuses a corrupted cached target before sending', async () => {
  const { storage, artifact, record, resolved } = fixture();
  const operation = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({ request: resolved });
  try {
    await expect(resolveSharedArtifactModification(operation, 'namespace', artifact, record, 'cancel')).rejects.toThrow(
      'lost response',
    );
    expect(storage.size).toBe(1);
    const [key, serialized] = [...storage.entries()][0];
    const corrupted = JSON.parse(serialized);
    corrupted.input.requestId = 'another-request';
    storage.set(key, JSON.stringify(corrupted));
    await expect(resolveSharedArtifactModification(operation, 'namespace', artifact, record, 'cancel')).rejects.toThrow(
      '引用已改变',
    );
    expect(operation).toHaveBeenCalledOnce();
    storage.set(key, serialized);
    await expect(
      resolveSharedArtifactModification(operation, 'namespace', artifact, record, 'cancel'),
    ).resolves.toEqual(resolved);
    expect(operation.mock.calls[1]).toEqual(operation.mock.calls[0]);
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  'cancel',
  'reject',
] as const)('releases a definitively stale %s intent, then uses the refreshed revision only on the next explicit attempt', async (action) => {
  const { storage, artifact, record, resolved } = fixture();
  const operation = vi.fn().mockRejectedValueOnce(new CollectiveClientRequestError(409, 'revision conflict'));
  try {
    await expect(resolveSharedArtifactModification(operation, 'namespace', artifact, record, action)).rejects.toThrow(
      'revision conflict',
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(storage.size).toBe(0);
    const refreshed = { ...record, revision: record.revision + 1 };
    const receipt = {
      ...resolved,
      revision: refreshed.revision + 1,
      resolution: { ...resolved.resolution, kind: action === 'cancel' ? 'cancelled' : 'rejected' },
    };
    operation.mockResolvedValue({ request: receipt });
    await expect(
      resolveSharedArtifactModification(operation, 'namespace', artifact, refreshed, action),
    ).resolves.toEqual(receipt);
    expect(operation.mock.calls[1][2]).toEqual({
      requestId: record.requestId,
      expectedRequestRevision: refreshed.revision,
      ...(action === 'reject' ? { proposalRef: record.latestProposalRef } : {}),
    });
    expect(operation.mock.calls[1][3]).not.toBe(operation.mock.calls[0][3]);
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('does not erase a newer cached decision when the older in-flight operation conflicts', async () => {
  const { storage, artifact, record } = fixture();
  let replacement: string | undefined;
  const operation = vi.fn(async () => {
    const [key, serialized] = [...storage.entries()][0];
    replacement = JSON.stringify({ ...JSON.parse(serialized), operationId: crypto.randomUUID() });
    storage.set(key, replacement);
    throw new CollectiveClientRequestError(409, 'revision conflict');
  });
  try {
    await expect(resolveSharedArtifactModification(operation, 'namespace', artifact, record, 'cancel')).rejects.toThrow(
      'revision conflict',
    );
    expect([...storage.values()]).toEqual([replacement]);
  } finally {
    vi.unstubAllGlobals();
  }
});
