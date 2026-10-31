import type { AssetCanonRecord, AssetCanonUpdate, WorkContextRecord } from '@cat-cafe/shared';
import { canonDigest, canonJson, indexedVersionRef } from './identity.js';
import type { AssetCanonStore } from './store.js';

export interface CanonNoticeEvidence {
  noticeScope: string;
  updateFingerprint: string;
  evidence: unknown;
  versionRefs: string[];
  original: AssetCanonRecord;
  replacement: AssetCanonRecord | null;
  metadataRevision: number;
  uses: string[];
  reason: string;
  change?: AssetCanonUpdate['change'];
}
export function traceCanon(store: AssetCanonStore, owner: string, original: AssetCanonRecord) {
  const chain: AssetCanonRecord[] = [];
  const visited = new Set<string>();
  let node: AssetCanonRecord | null = original;
  while (node) {
    if (visited.has(node.indexedVersionRef)) throw new Error('Corrupt supersession cycle');
    visited.add(node.indexedVersionRef);
    chain.push(node);
    node = node.supersededBy ? store.get(owner, node.supersededBy.indexedVersionRef) : null;
  }
  return chain;
}
function usage(rows: WorkContextRecord['context']['assets']) {
  return {
    uses: [...new Set(rows.flatMap((row) => row.uses))].sort(),
    selections: [
      ...new Set(rows.flatMap((row) => (row.bindingSelection ? [canonJson(row.bindingSelection)] : []))),
    ].sort(),
  };
}
export function noticeEvidence(
  store: AssetCanonStore,
  owner: string,
  metadata: WorkContextRecord,
  row: WorkContextRecord['context']['assets'][number],
  original: AssetCanonRecord,
): CanonNoticeEvidence[] {
  const chain = traceCanon(store, owner, original),
    terminal = chain.at(-1)!;
  const notices: CanonNoticeEvidence[] = [];
  const related = metadata.context.assets.filter((candidate) => {
    const version = candidate.asset.versions.find((v) => v.id === candidate.versionId)!;
    return indexedVersionRef(owner, version) === original.indexedVersionRef;
  });
  const evidence = chain.map((a) => ({
    indexedVersionRef: a.indexedVersionRef,
    revision: a.revision,
    status: a.status,
    judgment: a.judgment?.operationId,
    supersededBy: a.supersededBy,
  }));
  const base = { original, metadataRevision: metadata.metadataRevision };
  if (chain.length > 1 || original.status === 'experimental' || original.status === 'failed') {
    const sourceUsage = usage(related);
    const predecessor = chain.at(-2);
    const event = predecessor?.supersededBy
      ? store.latestHistory(
          owner,
          predecessor.indexedVersionRef,
          predecessor.supersededBy.eventRef.slice('supersession:'.length),
        )
      : original.judgment;
    notices.push({
      ...base,
      uses: sourceUsage.uses,
      noticeScope: 'asset',
      evidence: { chain: evidence, sourceUsage },
      versionRefs: chain.map((record) => record.indexedVersionRef),
      updateFingerprint: canonDigest({ scope: 'asset', evidence, sourceUsage }),
      replacement: chain.length > 1 && terminal.status === 'canonical' && !terminal.supersededBy ? terminal : null,
      reason: event?.reason ?? '',
      ...(event?.actor && event.recordedAt ? { change: { actor: event.actor, recordedAt: event.recordedAt } } : {}),
    });
  }
  const selection = row.bindingSelection;
  if (selection) {
    const current = store.binding(owner, selection.bindingRef);
    if (current && current.indexedVersionRef !== selection.indexedVersionRef) {
      const target = current.indexedVersionRef ? store.get(owner, current.indexedVersionRef) : null;
      const sourceUsage = usage(
        related.filter((candidate) => candidate.bindingSelection?.bindingRef === selection.bindingRef),
      );
      const bindingEvidence = {
        sourceUsage,
        currentBindingRevision: current.bindingRevision,
        currentIndexedVersionRef: current.indexedVersionRef,
        targetRevision: target?.revision ?? null,
      };
      notices.push({
        ...base,
        uses: sourceUsage.uses,
        noticeScope: current.bindingRef,
        evidence: bindingEvidence,
        versionRefs: [original.indexedVersionRef, ...(target ? [target.indexedVersionRef] : [])],
        updateFingerprint: canonDigest(bindingEvidence),
        replacement: target?.status === 'canonical' && !target.supersededBy ? target : null,
        reason: current.reason,
        change: { actor: current.actor, recordedAt: current.recordedAt },
      });
    }
  }
  return notices;
}
