import type { AssetCanonItem, AssetCanonUpdate, WorkContextRecord } from '@cat-cafe/shared';

const actor = { kind: 'cat' as const, actorId: 'director' };
const at = '2026-10-26T00:00:00.000Z';
export const item: AssetCanonItem = {
  record: {
    indexedVersionRef: `asset:sha256:${'a'.repeat(64)}`,
    ownerUserId: 'owner',
    name: 'hero.png',
    kind: '图片',
    version: {
      id: 'v1',
      locator: { kind: 'workspace', rootId: 'root', path: 'hero.png' },
      sha256: `sha256:${'b'.repeat(64)}`,
      byteLength: 10,
      mediaType: 'image/png',
      recordedAt: at,
      origin: { kind: 'created', actor, at, refs: [] },
    },
    creator: actor,
    source: { kind: 'workspace', threadId: 'film' },
    createdAt: at,
    applicability: [],
    revision: 0,
    status: null,
    judgment: null,
    supersededBy: null,
  },
  fileState: 'available',
  canWrite: true,
  bindings: [],
  work: { reference: { contentRef: 'work:film', ownerRevision: 4 }, metadataRevision: 3, assetId: 'hero' },
};
export const record: WorkContextRecord = {
  reference: item.work!.reference,
  metadataRevision: 3,
  ownerUserId: 'owner',
  operationId: 'index',
  requestDigest: `sha256:${'c'.repeat(64)}`,
  actor,
  recordedAt: at,
  context: {
    format: 'video',
    extractorVersion: 'test',
    provenance: [{ ref: 'source', digest: `sha256:${'d'.repeat(64)}` }],
    story: [],
    assets: [
      {
        asset: { id: 'hero', name: 'hero.png', kind: '图片', versions: [item.record.version] },
        versionId: 'v1',
        uses: ['全片'],
      },
    ],
  },
};
export const update: AssetCanonUpdate = {
  kind: 'replacement_available',
  original: item,
  replacement: {
    ...item,
    record: {
      ...item.record,
      name: 'new.png',
      indexedVersionRef: `asset:sha256:${'e'.repeat(64)}`,
      status: 'canonical',
    },
  },
  reason: '换成已定稿原图',
  changeRef: 'replacement:1',
  uses: ['全片'],
  noticeScope: 'asset',
  updateFingerprint: `sha256:${'f'.repeat(64)}`,
  decisionRevision: 0,
};
