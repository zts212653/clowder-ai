import { expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import { CollectiveClientRequestError } from '../client-request.js';
import { collectiveArtifactClient, type SharedArtifact } from '../collective-artifact-client.js';

it('replays the same explicit Cafe after a lost offer response without selecting another destination', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
  } as SharedArtifact;
  const sent: Record<string, unknown>[] = [];
  const request: ClientRequest = async <Result>(_path: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    if (sent.length === 1) throw new Error('lost offer response');
    return { handoffRef: 'one-durable-transfer' } as Result;
  };
  try {
    const api = collectiveArtifactClient(request, artifact, 'same-human').management;
    await expect(api.offer(artifact, 'member', 4, 'chosen-cafe')).rejects.toThrow('lost offer response');
    await collectiveArtifactClient(request, artifact, 'same-human').management.recover(artifact);
    expect(sent[0]).toMatchObject({
      targetHumanId: 'member',
      targetConnectionId: 'chosen-cafe',
      expectedCustodyRevision: 4,
    });
    expect(sent[1]).toEqual(sent[0]);
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('recovers a lost manager operation from the same Human namespace with its original CAS and refuses another cached Artifact', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const coordinates = { serviceInstanceId: 'service', collectiveId: 'collective' };
  const artifact = { ...coordinates, artifactId: 'artifact' } as SharedArtifact;
  const sends: { path: string; input: Record<string, unknown> }[] = [];
  const request: ClientRequest = async <Result>(path: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sends.push({ path, input });
    if (sends.length === 1) throw new Error('lost manager response');
    return { artifact } as Result;
  };
  try {
    const api = collectiveArtifactClient(request, coordinates, 'human-one').management;
    await expect(api.setAccess(artifact, 'member', 'apply', 3)).rejects.toThrow('lost manager response');
    expect(api.hasPending(artifact)).toBe(true);
    expect(collectiveArtifactClient(request, coordinates, 'another-human').management.hasPending(artifact)).toBe(false);
    const reopened = collectiveArtifactClient(request, coordinates, 'human-one').management;
    const [key, serialized] = [...storage.entries()][0];
    const corrupted = JSON.parse(serialized);
    corrupted.input.artifactId = 'another-artifact';
    storage.set(key, JSON.stringify(corrupted));
    await expect(reopened.recover(artifact)).rejects.toThrow('引用');
    expect(sends).toHaveLength(1);
    storage.set(key, serialized);
    await reopened.recover(artifact);
    expect(sends[1]).toEqual(sends[0]);
    expect(storage.size).toBe(0);
    expect(sends[0].input).toMatchObject({
      ...coordinates,
      artifactId: artifact.artifactId,
      expectedAccessRevision: 3,
      access: 'apply',
      humanId: 'member',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('clears only a confirmed CAS refusal so a fresh explicit manager operation can use the new revision', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
  } as SharedArtifact;
  const sent: Record<string, unknown>[] = [];
  const request: ClientRequest = async <Result>(_path: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    if (sent.length === 1) throw new CollectiveClientRequestError(409, 'stale policy');
    return { artifact } as Result;
  };
  try {
    const api = collectiveArtifactClient(request, artifact, 'same-human').management;
    await expect(api.setAccess(artifact, 'member', 'apply', 1)).rejects.toThrow('stale policy');
    expect(api.hasPending(artifact)).toBe(false);
    await api.setAccess(artifact, 'member', 'apply', 2);
    expect(sent[1].expectedAccessRevision).toBe(2);
    expect(sent[1].requestId).not.toBe(sent[0].requestId);
  } finally {
    vi.unstubAllGlobals();
  }
});
