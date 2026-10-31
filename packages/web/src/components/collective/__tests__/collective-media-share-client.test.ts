import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import {
  mediaArtifact,
  mediaRef,
} from '../../../../../collective-client/src/__tests__/collective-media-surface.fixture';
import { shareRetainedMediaFromHost } from '../collective-media-share-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.restoreAllMocks();
  localStorage.clear();
});
const selected = {
  contentRef: mediaArtifact.contentRef,
  ownerRevision: 1,
  label: '图片',
  mediaType: 'image/png' as const,
};
const reply = () => new Response(JSON.stringify(mediaArtifact), { status: 200 });
const registration = (revision = 1, custodyRevision = 1) => ({
  serviceInstanceId: mediaRef.serviceInstanceId,
  collectiveId: mediaRef.collectiveId,
  connectionId: mediaRef.connectionId,
  contentRef: selected.contentRef,
  sourceEventId: mediaRef.sourceEventId,
  mediaType: selected.mediaType,
  current: { revision, custodyRevision },
});
const contextReply = () => new Response(JSON.stringify(registration()));
const send = () => shareRetainedMediaFromHost('/local', mediaRef, selected, mediaArtifact.title, 'own-source-draft');

it('the normal picker carries the current catalogue and custody CAS for a second retained version', async () => {
  const next = { ...selected, ownerRevision: 2 };
  const updated = {
    ...mediaArtifact,
    revision: 8,
    versionCount: 2,
    versions: [{ ...mediaArtifact.versions[0], ownerRevision: 2 }],
  };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/share-media/context'))
      return new Response(
        JSON.stringify({
          serviceInstanceId: mediaRef.serviceInstanceId,
          collectiveId: mediaRef.collectiveId,
          connectionId: mediaRef.connectionId,
          contentRef: selected.contentRef,
          sourceEventId: mediaRef.sourceEventId,
          mediaType: selected.mediaType,
          current: { revision: 7, custodyRevision: 3 },
        }),
      );
    const body = JSON.parse(String(init?.body));
    return body.expectedRevision === 7 && body.expectedCustodyRevision === 3
      ? new Response(JSON.stringify(updated))
      : new Response('{}', { status: 409 });
  });
  await expect(shareRetainedMediaFromHost('/local', mediaRef, next, mediaArtifact.title, 'v2')).resolves.toEqual(
    updated,
  );
});

it('retains the same publication operation across a lost response and a remounted picker', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(contextReply())
    .mockRejectedValueOnce(new TypeError('connection lost'))
    .mockResolvedValueOnce(reply());
  await expect(send()).rejects.toThrow('分享尚未确认');
  await expect(send()).resolves.toEqual(mediaArtifact);
  const bodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([url]) => String(url).endsWith('/share-media'))
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ expectedRevision: 1, expectedCustodyRevision: 1 });
  expect(apiFetch).toHaveBeenCalledTimes(3);
  expect(bodies[0]).not.toHaveProperty('blobDigest');
  expect(bodies[0]).not.toHaveProperty('receiptRef');
});

it('starts no owner effect if the operation receipt cannot be persisted', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(contextReply());
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  await expect(send()).rejects.toThrow('storage unavailable');
  expect(vi.mocked(apiFetch).mock.calls.every(([url]) => String(url).endsWith('/share-media/context'))).toBe(true);
});

it('rejects a successful response for another source, version or exact retained object', async () => {
  for (const changed of [
    { sourceEventId: 'other-source' },
    { contentRef: 'other-object' },
    { versions: [{ ...mediaArtifact.versions[0], ownerRevision: 2 }] },
  ]) {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      String(url).endsWith('/share-media/context')
        ? contextReply()
        : new Response(JSON.stringify({ ...mediaArtifact, ...changed }), { status: 200 }),
    );
    await expect(send()).rejects.toThrow('分享回执与所选作品不一致');
  }
});

it('refuses a borrowed catalogue tuple or revoked context before submitting a share', async () => {
  for (const changed of [
    { connectionId: 'other-connection' },
    { contentRef: 'other-retained-object' },
    { sourceEventId: 'other-source' },
    { serviceInstanceId: 'other-service' },
  ]) {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...registration(), ...changed })));
    await expect(send()).rejects.toThrow('分享回执与所选作品不一致');
  }
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 403 }));
  await expect(send()).rejects.toThrow('这件作品现在不可分享');
  expect(vi.mocked(apiFetch).mock.calls.every(([url]) => String(url).endsWith('/share-media/context'))).toBe(true);
});

it('surfaces a stale CAS without automatically refreshing authority or retrying the effect', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(contextReply())
    .mockResolvedValueOnce(new Response('{}', { status: 409 }));
  await expect(send()).rejects.toThrow('作品已变化');
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(localStorage.length).toBe(0);
});

it('preserves an earlier picker UUID as its original committed-replay payload', async () => {
  const input = {
    contentRef: selected.contentRef,
    ownerRevision: 1,
    sourceEventId: mediaRef.sourceEventId,
    title: mediaArtifact.title,
  };
  const requestId = crypto.randomUUID();
  localStorage.setItem(`own-source-draft:operation:${JSON.stringify(input)}`, requestId);
  vi.mocked(apiFetch).mockResolvedValueOnce(reply());
  await expect(send()).resolves.toEqual(mediaArtifact);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body))).toEqual({ ...input, requestId });
});

it('lets an earlier failed UUID-only picker prepare CAS on the next explicit share after a definite 409', async () => {
  const input = {
    contentRef: selected.contentRef,
    ownerRevision: 1,
    sourceEventId: mediaRef.sourceEventId,
    title: mediaArtifact.title,
  };
  const oldId = crypto.randomUUID();
  localStorage.setItem(`own-source-draft:operation:${JSON.stringify(input)}`, oldId);
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(new Response('{}', { status: 409 }))
    .mockResolvedValueOnce(contextReply())
    .mockResolvedValueOnce(reply());
  await expect(send()).rejects.toThrow('作品已变化');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await expect(send()).resolves.toEqual(mediaArtifact);
  const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[2][1]?.body));
  expect(body).toMatchObject({ expectedRevision: 1, expectedCustodyRevision: 1 });
  expect(body.requestId).not.toBe(oldId);
});
