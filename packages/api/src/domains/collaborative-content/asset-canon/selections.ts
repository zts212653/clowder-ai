import type { WorkVideoContext } from '@cat-cafe/shared';
import type { WorkPrincipal } from '../works/types.js';
import type { CanonAssetAccess } from './access.js';
import { canonJson, indexedVersionRef } from './identity.js';
import { currentCanon, requireCanonAsset } from './mutations.js';
import { AssetCanonConflictError, type AssetCanonStore } from './store.js';

type AssetUse = WorkVideoContext['assets'][number];
function retainedSelection(row: AssetUse, owner: string, retained?: WorkVideoContext) {
  const before = retained?.assets.find((asset) => asset.asset.id === row.asset.id);
  if (!before?.bindingSelection || !row.bindingSelection) return false;
  const version = before.asset.versions.find((v) => v.id === before.versionId)!;
  return (
    canonJson(before.bindingSelection) === canonJson(row.bindingSelection) &&
    indexedVersionRef(owner, version) === row.bindingSelection.indexedVersionRef
  );
}
export function assertCanonSelections(
  store: AssetCanonStore,
  context: WorkVideoContext,
  owner: string,
  retained?: WorkVideoContext,
) {
  for (const row of context.assets) {
    const selection = row.bindingSelection;
    if (!selection) continue;
    const version = row.asset.versions.find((v) => v.id === row.versionId)!;
    const historical = store.binding(owner, selection.bindingRef, selection.bindingRevision);
    if (
      indexedVersionRef(owner, version) !== selection.indexedVersionRef ||
      historical?.indexedVersionRef !== selection.indexedVersionRef
    )
      throw new AssetCanonConflictError('Binding citation does not match its original selection');
    // A fixed film may refine its subtitles/index while retaining the bytes and selection it actually used.
    if (retainedSelection(row, owner, retained)) continue;
    const current = store.binding(owner, selection.bindingRef);
    const record = store.get(owner, selection.indexedVersionRef);
    if (current?.bindingRevision !== selection.bindingRevision || !record || !currentCanon(record))
      throw new AssetCanonConflictError('Canonical binding selection changed');
  }
}
export async function verifyCanonSelections(
  access: CanonAssetAccess,
  context: WorkVideoContext,
  principal: WorkPrincipal,
  retained?: WorkVideoContext,
) {
  for (const row of context.assets) {
    if (!row.bindingSelection || retainedSelection(row, principal.userId, retained)) continue;
    const record = requireCanonAsset(access.deps.store, principal.userId, row.bindingSelection.indexedVersionRef);
    const item = await access.item(record, principal);
    if (item.fileState !== 'available') throw new AssetCanonConflictError('Selected source is unavailable');
  }
  assertCanonSelections(access.deps.store, context, principal.userId, retained);
}
