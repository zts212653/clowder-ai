import type { AssetCanonItem, AssetCanonRecord, WorkContextRecord } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkContextStore } from '../works/context-store.js';
import type { WorkPrincipal } from '../works/types.js';
import type { CanonAssetAccess } from './access.js';
import { indexedVersionRef } from './identity.js';
import { CanonReadScope } from './read-scope.js';

export function indexUsedAsset(
  access: CanonAssetAccess,
  contexts: WorkContextStore,
  metadata: WorkContextRecord,
  index: number,
  threadId: string,
  records?: Map<string, WorkContextRecord>,
) {
  const used = metadata.context.assets[index];
  const selected = used?.asset.versions.find((v) => v.id === used.versionId);
  if (!used || !selected) throw new Error('Selected asset is not indexed');
  const ref = indexedVersionRef(metadata.ownerUserId, selected);
  const existing = access.deps.store.get(metadata.ownerUserId, ref);
  if (existing) return existing;
  // Opening a later Work cannot mint a new global creator for an already-used file.
  const origin = contexts.assetOrigin(metadata.ownerUserId, selected, records);
  if (!origin) throw new MediaOwnerError('media_unavailable');
  const source = origin.metadata;
  const row = source.context.assets[origin.index]!;
  const version = row.asset.versions.find((v) => v.id === row.versionId)!;
  return access.deps.store.index({
    indexedVersionRef: ref,
    ownerUserId: metadata.ownerUserId,
    name: row.asset.name,
    kind: row.asset.kind,
    version,
    applicability: [],
    creator: source.actor,
    evidenceRefs: source.context.provenance.map((source) => source.ref).slice(0, 100),
    source: {
      kind: 'work',
      threadId,
      reference: source.reference,
      metadataRevision: source.metadataRevision,
      assetId: row.asset.id,
    },
    createdAt: source.recordedAt,
    revision: 0,
    status: null,
    judgment: null,
    supersededBy: null,
  });
}

/** A readable use proves this file, not access to another Work or global write authority. */
export async function readUsedItem(
  access: CanonAssetAccess,
  record: AssetCanonRecord,
  metadata: WorkContextRecord,
  index: number,
  principal: WorkPrincipal,
  verifyFiles = true,
  reads?: CanonReadScope,
): Promise<AssetCanonItem> {
  let visible = record;
  try {
    await access.authorize(record, principal, false, reads);
  } catch (error) {
    if (!(error instanceof MediaOwnerError && error.code === 'access_denied')) throw error;
    const context = reads
      ? await reads.read(metadata.reference, principal, metadata.metadataRevision)
      : await access.deps.contexts.read(metadata.reference, principal, metadata.metadataRevision);
    const row = context?.context.assets[index];
    const version = row?.asset.versions.find((v) => v.id === row.versionId);
    if (!row || !version || indexedVersionRef(principal.userId, version) !== record.indexedVersionRef)
      throw new MediaOwnerError('access_denied');
    // Read-only projection: never persist this alternative source or expose the hidden origin's metadata.
    visible = {
      ...record,
      name: row.asset.name,
      kind: row.asset.kind,
      version,
      source: {
        kind: 'work',
        threadId: principal.threadId,
        reference: metadata.reference,
        metadataRevision: metadata.metadataRevision,
        assetId: row.asset.id,
      },
      evidenceRefs: [],
      applicability: [],
      judgment: null,
    };
    await access.authorize(visible, principal, false, reads);
  }
  const item: AssetCanonItem =
    verifyFiles || visible.supersededBy
      ? await access.item(visible, principal, { allowUnavailable: true, reads })
      : { record: visible, fileState: 'unverified', canWrite: false, bindings: [] };
  return {
    ...item,
    ...(visible !== record ? { canWrite: false, bindings: [] } : {}),
    work: {
      reference: metadata.reference,
      metadataRevision: metadata.metadataRevision,
      assetId: metadata.context.assets[index]!.asset.id,
    },
  };
}
export async function usedItems(
  access: CanonAssetAccess,
  contexts: WorkContextStore,
  metadata: WorkContextRecord,
  principal: WorkPrincipal,
  after: number,
  limit: number,
  verifyFiles = true,
): Promise<AssetCanonItem[]> {
  const result: AssetCanonItem[] = [];
  const reads = new CanonReadScope(access.deps.contexts, principal, metadata);
  const checkedRoots = new Set<string>();
  for (let i = after; i < Math.min(metadata.context.assets.length, after + limit); i++) {
    const record = indexUsedAsset(access, contexts, metadata, i, principal.threadId, reads.records);
    if (!checkedRoots.has(record.version.locator.rootId)) {
      await access.deps.authorizeRoot(record.version, principal);
      checkedRoots.add(record.version.locator.rootId);
    }
    result.push(await readUsedItem(access, record, metadata, i, principal, verifyFiles, reads));
  }
  for (const root of checkedRoots) {
    const version = result.find((item) => item.record.version.locator.rootId === root)!.record.version;
    await access.deps.authorizeRoot(version, principal);
  }
  await reads.revalidate();
  await access.deps.authorize(principal);
  return result;
}
export async function otherUses(
  access: CanonAssetAccess,
  contexts: WorkContextStore,
  ref: string,
  principal: WorkPrincipal,
  after: number,
) {
  const page = contexts.usagePage(principal.userId, after, 50);
  const uses = [];
  for (const metadata of page) {
    const matching = metadata.context.assets.filter((row) => {
      const version = row.asset.versions.find((v) => v.id === row.versionId);
      return version && indexedVersionRef(principal.userId, version) === ref;
    });
    if (!matching.length) continue;
    try {
      await access.deps.contexts.read(metadata.reference, principal, metadata.metadataRevision);
    } catch {
      continue;
    }
    uses.push({
      reference: metadata.reference,
      metadataRevision: metadata.metadataRevision,
      title: contexts.workTitle(principal.userId, metadata.reference),
      uses: matching.flatMap((r) => r.uses),
    });
  }
  return { uses, ...(page.length === 50 ? { nextAfter: after + 50 } : {}) };
}
