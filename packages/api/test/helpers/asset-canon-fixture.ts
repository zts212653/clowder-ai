import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetCanonRecord, WorkVideoContext } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../../src/domains/collaborative-content/artifact-review/store.js';
import { AssetCanonService } from '../../src/domains/collaborative-content/asset-canon/service.js';
import { WorkVideoContextService } from '../../src/domains/collaborative-content/works/video-context.js';
import { MediaOwnerError } from '../../src/domains/video-studio/content-owner/media-errors.js';
import { VideoProjectAssetIndex } from '../../src/domains/video-studio/project/asset-index.js';

export const canonHuman = { userId: 'owner', threadId: 'film', actor: { kind: 'human' as const, actorId: 'owner' } };
export const canonCat = { ...canonHuman, invocationId: 'active', actor: { kind: 'cat' as const, actorId: 'director' } };
export const canonReference = { contentRef: 'work:film', ownerRevision: 1 };
export async function canonFixture() {
  const root = await mkdtemp(join(tmpdir(), 'f326-canon-'));
  const dbPath = join(root, 'f309.sqlite');
  const store = new ArtifactReviewStore(dbPath);
  const denied = new Set<string>();
  const assets = new VideoProjectAssetIndex({
    resolveRoot: async (id) => {
      if (denied.has('root')) throw new MediaOwnerError('access_denied');
      return { canonicalWorktreeId: id, root };
    },
  });
  const authorizeWork = async (reference: { contentRef: string }) => {
    if (denied.has(reference.contentRef)) throw new MediaOwnerError('access_denied');
  };
  let canon: AssetCanonService | undefined;
  const contexts = new WorkVideoContextService({
    store: store.works.contexts,
    authorize: authorizeWork,
    verifyAssets: (context, principal, retained) => canon!.verifySelections(context, principal, retained),
    assertAssetSelections: (context, owner, retained) => canon!.assertSelections(context, owner, retained),
    media: async () => ({ kind: 'video', streamId: 'v', startTick: 0, durationTicks: 100 }),
  });
  const service = new AssetCanonService({
    store: store.works.assets,
    contextStore: store.works.contexts,
    contexts,
    authorize: async (principal) => {
      if (principal.userId !== 'owner' || denied.has('producer')) throw new MediaOwnerError('access_denied');
    },
    authorizeWork,
    authorizeRoot: async () => {
      if (denied.has('root')) throw new MediaOwnerError('access_denied');
    },
    inspect: (version) => assets.inspect(version.locator),
    assertMember: async (id) => {
      if (id !== 'director') throw new MediaOwnerError('access_denied');
    },
  });
  canon = service;
  let seq = 0;
  const image = async (name: string, body = name, applicability: AssetCanonRecord['applicability'] = []) => {
    await writeFile(join(root, name), body);
    const version = {
      id: name,
      mediaType: 'image/png',
      byteLength: Buffer.byteLength(body),
      sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      recordedAt: new Date().toISOString(),
      locator: { kind: 'workspace' as const, rootId: 'root', path: name },
      origin: { kind: 'created' as const, actor: canonCat.actor, at: new Date().toISOString(), refs: [] },
    };
    const result = (await service.run(
      { action: 'index-asset', operationId: `index-${seq++}`, name, kind: 'image', version, applicability },
      canonCat,
    )) as { assets: AssetCanonRecord[] };
    return result.assets[0]!;
  };
  const mark = async (record: AssetCanonRecord, status: 'canonical' | 'experimental' | 'failed' = 'canonical') => {
    const current = store.works.assets.get('owner', record.indexedVersionRef)!;
    const result = (await service.run(
      {
        action: 'set-asset-status',
        indexedVersionRef: record.indexedVersionRef,
        expectedRevision: current.revision,
        operationId: `mark-${seq++}`,
        status,
        reason: `选择 ${status}`,
      },
      canonCat,
    )) as { assets: AssetCanonRecord[] };
    return result.assets[0]!;
  };
  const replace = async (a: AssetCanonRecord, b: AssetCanonRecord) =>
    service.run(
      {
        action: 'supersede-asset',
        mode: 'replace',
        fromVersionRef: a.indexedVersionRef,
        toVersionRef: b.indexedVersionRef,
        expectedFromRevision: store.works.assets.get('owner', a.indexedVersionRef)!.revision,
        expectedToRevision: store.works.assets.get('owner', b.indexedVersionRef)!.revision,
        operationId: `replace-${seq++}`,
        reason: '采用已定稿的新图',
      },
      canonCat,
    );
  const use = async (
    records: AssetCanonRecord[],
    reference = canonReference,
    bindingSelection?: WorkVideoContext['assets'][number]['bindingSelection'],
  ) => {
    const metadata = store.works.contexts.get('owner', reference);
    return contexts.save(
      {
        action: 'set-context',
        operationId: `context-${seq++}`,
        reference,
        expectedMetadataRevision: metadata?.metadataRevision ?? 0,
        context: {
          format: 'video',
          extractorVersion: 'test',
          provenance: [{ ref: 'exact-source', digest: `sha256:${'a'.repeat(64)}` }],
          story: [],
          assets: records.map((a) => ({
            asset: { id: a.name, name: a.name, kind: a.kind, versions: [a.version] },
            versionId: a.version.id,
            uses: ['全片'],
            ...(bindingSelection ? { bindingSelection } : {}),
          })),
        },
      },
      canonCat,
    );
  };
  return {
    root,
    dbPath,
    store,
    contexts,
    service,
    denied,
    assets,
    image,
    mark,
    replace,
    use,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
