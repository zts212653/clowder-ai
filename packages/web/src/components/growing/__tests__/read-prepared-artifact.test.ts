import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedArtifactCoordinate } from '../PreparedArtifactPreview';
import { readPreparedArtifact } from '../read-prepared-artifact';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));
const coordinate: PreparedArtifactCoordinate = {
  artifactRef: '/uploads/original.md',
  artifactRevision: '700',
  completenessRef: 'message:source:published#available:700',
  previewRef: 'message:source:published#preview:700',
  openInWorkspaceRef: 'workspace:artifact:source:700:/uploads/original.md',
};
const artifact = {
  type: 'file',
  name: 'Original',
  createdAt: 700,
  sourceMessageId: 'published',
  url: coordinate.artifactRef,
};
const read = (input = coordinate) => readPreparedArtifact(input, new AbortController().signal);

describe('prepared Artifact owner reads', () => {
  beforeEach(() => fetch.mockReset());

  it('retains a thread identifier containing delimiters and encodes it as one path segment', async () => {
    const threadId = 'imported:thread/作品';
    fetch.mockResolvedValue(new Response(JSON.stringify({ threadId, artifacts: [artifact] })));
    const result = await read({
      ...coordinate,
      openInWorkspaceRef: `workspace:artifact:${threadId}:700:${coordinate.artifactRef}`,
    });
    expect(result?.threadId).toBe(threadId);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/threads/${encodeURIComponent(threadId)}/artifacts`);
  });

  it.each([401, 403, 404, 500])('keeps HTTP %i unavailable without a global fallback', async (status) => {
    fetch.mockResolvedValue(new Response('{}', { status }));
    await expect(read()).rejects.toThrow(`Artifact owner read failed: ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/threads/source/artifacts');
  });

  it.each([
    { threadId: 'another', artifacts: [artifact] },
    { threadId: 'source', artifacts: [{ ...artifact, createdAt: 701 }] },
    { threadId: 'source', artifacts: [artifact, artifact] },
    { threadId: 'source', artifacts: [] },
  ])('does not substitute a changed, ambiguous or missing publication', async (body) => {
    fetch.mockResolvedValue(new Response(JSON.stringify(body)));
    expect(await read()).toBeUndefined();
  });

  it.each([
    'workspace:artifact:source:701:/uploads/original.md',
    'workspace:artifact:source:700:/uploads/another.md',
    'https://untrusted.example/file',
  ])('rejects an inconsistent coordinate before requesting %s', async (openInWorkspaceRef) => {
    expect(await read({ ...coordinate, openInWorkspaceRef })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
