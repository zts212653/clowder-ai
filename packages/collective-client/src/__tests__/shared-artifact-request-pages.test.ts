import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import { collectiveArtifactClient, type SharedArtifact } from '../collective-artifact-client.js';

const text = '# same owner';
const blobDigest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
const at = '2026-10-16T00:00:00Z';
const artifact: SharedArtifact = {
  serviceInstanceId: 'service',
  collectiveId: 'collective',
  artifactId: 'artifact',
  contentRef: 'content',
  publishedByHumanId: 'publisher',
  sourceEventId: 'source',
  sourceLocation: { channelId: 'general' },
  title: 'Shared',
  mediaType: 'text/markdown',
  revision: 1,
  accessRevision: 1,
  canApply: false,
  availability: 'available',
  createdAt: at,
  updatedAt: at,
  versionCount: 1,
  versions: [{ ownerRevision: 1, blobDigest, receiptRef: 'first', recordedAt: at }],
};
const record = (index: number) => ({
  requestId: `f309-modification-${String(index).repeat(64)}`,
  revision: 1,
  state: 'requested',
  requestingHumanId: 'reader',
  target: { humanId: 'publisher', catId: 'codex61-sol' },
  ownerRevision: 1,
  blobDigest,
  requestEventId: `request-${index}`,
  sourceEventId: 'source',
  location: { channelId: 'general', rootEventId: 'evt_shared-source-0001' },
  annotationIds: ['note'],
  createdAt: index,
  updatedAt: index,
});

for (const drift of [false, true])
  it(`loads one earlier owner page only on request and rejects journal drift=${drift}`, async () => {
    const offsets: number[] = [];
    const request: ClientRequest = async <Result>(_path: string, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as { payload: { requestOffset?: number }; ownerRevision?: number };
      const offset = command.payload.requestOffset ?? 0;
      offsets.push(offset);
      if (offset) expect(command.ownerRevision).toBe(1);
      return {
        value: {
          contentRef: 'content',
          ownerRevision: 1,
          blobDigest,
          text,
          view: {
            review: {
              version: 1,
              reviewId: 'ledger',
              contentRef: 'content',
              revision: 1,
              source: {
                kind: 'collective-artifact',
                revision: blobDigest,
                ownerRevision: 1,
                mime: 'text/markdown',
                byteLength: text.length,
              },
              collaborationScope: {
                kind: 'collective-artifact',
                scopeRef: 'scope',
                serviceInstanceId: 'service',
                collectiveId: 'collective',
                artifactId: 'artifact',
              },
              annotations: [],
              createdAt: at,
              updatedAt: at,
            },
            historyReadOnly: false,
            canWrite: true,
            annotationPage: { offset: 0, total: 0 },
          },
          modifications: {
            total: 2,
            offset,
            snapshot: `sha256:${(drift && offset ? 'b' : 'a').repeat(64)}`,
            requests: [record(offset)],
            ...(offset ? {} : { nextOffset: 1 }),
          },
        },
      } as Result;
    };
    const api = collectiveArtifactClient(
      request,
      { serviceInstanceId: 'service', collectiveId: 'collective' },
      'reader',
    );
    const first = await api.read(artifact);
    expect(first.modifications?.requests).toHaveLength(1);
    expect(offsets).toEqual([0]);
    if (drift) await expect(api.moreRequests(artifact, first)).rejects.toThrow('修改记录');
    else {
      const read = await api.moreRequests(artifact, first);
      expect(read.modifications?.requests.map((item) => item.requestEventId)).toEqual(['request-0', 'request-1']);
      expect(read.modifications?.nextOffset).toBeUndefined();
    }
    expect(offsets).toEqual([0, 1]);
  });
