import { expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import {
  collectiveArtifactClient,
  readArtifactJsonPages,
  type SharedArtifact,
  SharedArtifactCatalogueReconciled,
} from '../collective-artifact-client.js';

it('reads the exact complete escaped owner snapshot and never returns a partially assembled document', async () => {
  const source = JSON.stringify({ text: '# 原文\n'.repeat(10000), annotations: ['正文中的选区'] });
  const seen: Record<string, unknown>[] = [];
  const result = await readArtifactJsonPages(async (page) => {
    seen.push(page);
    const cursor = typeof page.cursor === 'number' ? page.cursor : 0;
    return {
      encoding: 'json-text-chunk',
      snapshot: 'same-owner-snapshot',
      json: source.slice(cursor, cursor + 1024),
      nextCursor: cursor + 1024 < source.length ? cursor + 1024 : null,
    };
  });
  expect(result).toEqual(JSON.parse(source));
  expect(seen.length).toBeGreaterThan(10);
  expect(seen[1]).toEqual({ cursor: 1024, expectedSnapshot: 'same-owner-snapshot' });
});

it('refreshes a reconciled catalogue before requesting another body page from a now newer owner revision', async () => {
  const read = vi.fn(async () => ({
    encoding: 'json-text-chunk',
    snapshot: 'old-version',
    json: '{',
    nextCursor: 1,
    catalogueReconciled: true,
  }));
  await expect(readArtifactJsonPages(read)).rejects.toBeInstanceOf(SharedArtifactCatalogueReconciled);
  expect(read).toHaveBeenCalledOnce();
});

it('refuses a changed owner snapshot and broken cursors rather than displaying mixed versions', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ encoding: 'json-text-chunk', snapshot: 'first', json: '{"text":', nextCursor: 8 })
    .mockResolvedValueOnce({ encoding: 'json-text-chunk', snapshot: 'second', json: '"wrong"}', nextCursor: null });
  await expect(readArtifactJsonPages(read)).rejects.toThrow('更新');
  await expect(
    readArtifactJsonPages(async () => ({ encoding: 'json-text-chunk', snapshot: 'first', json: '{', nextCursor: 0 })),
  ).rejects.toThrow('未完成');
});

it('resolves the canonical result first and lets only its accountable Human start first publication', async () => {
  const coordinates = { serviceInstanceId: 'service', collectiveId: 'collective' };
  const artifact: SharedArtifact = {
    ...coordinates,
    artifactId: 'artifact',
    contentRef: 'owner-content',
    publishedByHumanId: 'human',
    title: 'Original result',
    mediaType: 'text/markdown',
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
    workId: 'work_abcdefgh',
    revision: 1,
    versions: [
      {
        ownerRevision: 1,
        blobDigest: `sha256:${'a'.repeat(64)}`,
        receiptRef: 'receipt',
        recordedAt: '2026-10-22T00:00:00.000Z',
      },
    ],
    versionCount: 1,
    availability: 'available',
    accessRevision: 1,
    canApply: true,
    canManageAccess: true,
    canManageCustody: true,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  const request = vi.fn(async <Result>(path: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ ...coordinates, fileId: `wrf_${'b'.repeat(64)}` });
    if (path === '/api/artifacts/publications/resolve-result')
      return { resolution: { status: 'unpublished', mayPromote: true } } as Result;
    expect(path).toBe('/api/artifacts/publications/promote-result');
    return { publication: { status: 'published', artifact } } as Result;
  }) as ClientRequest;
  await expect(
    collectiveArtifactClient(request, coordinates, 'owner').openWorkResult(`wrf_${'b'.repeat(64)}`),
  ).resolves.toEqual(artifact);
  expect(request).toHaveBeenCalledTimes(2);
});

it('opens an already published result for a read-only member without attempting owner publication', async () => {
  const coordinates = { serviceInstanceId: 'service', collectiveId: 'collective' };
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    contentRef: 'owner-content',
    publishedByHumanId: 'owner-human',
    title: 'Original result',
    mediaType: 'text/markdown',
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
    workId: 'work_abcdefgh',
    revision: 1,
    versions: [
      {
        ownerRevision: 1,
        blobDigest: `sha256:${'a'.repeat(64)}`,
        receiptRef: 'receipt',
        recordedAt: '2026-10-22T00:00:00.000Z',
      },
    ],
    versionCount: 1,
    availability: 'available',
    accessRevision: 1,
    canApply: false,
    canManageAccess: false,
    canManageCustody: false,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  } satisfies SharedArtifact;
  const request = vi.fn(async <Result>(path: string, init?: RequestInit) => {
    expect(path).toBe('/api/artifacts/publications/resolve-result');
    expect(JSON.parse(String(init?.body))).toEqual({ ...coordinates, fileId: `wrf_${'c'.repeat(64)}` });
    return { resolution: { status: 'published', mayPromote: false, artifact } } as Result;
  }) as ClientRequest;
  await expect(
    collectiveArtifactClient(request, coordinates, 'member').openWorkResult(`wrf_${'c'.repeat(64)}`),
  ).resolves.toEqual(artifact);
  expect(request).toHaveBeenCalledOnce();
});

it('does not turn a non-owner unresolved result into a publication attempt', async () => {
  const coordinates = { serviceInstanceId: 'service', collectiveId: 'collective' };
  const request = vi.fn(
    async <Result>() =>
      ({
        resolution: { status: 'unpublished', mayPromote: false },
      }) as Result,
  ) as ClientRequest;
  await expect(
    collectiveArtifactClient(request, coordinates, 'member').openWorkResult(`wrf_${'d'.repeat(64)}`),
  ).rejects.toThrow('尚未发布');
  expect(request).toHaveBeenCalledOnce();
});
