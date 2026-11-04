import type { WorkCoverPick, WorkCoverRecord, WorkReference } from '@cat-cafe/shared';
import type { WorkPrincipal } from '../types.js';
import { type WorkCoverService, workCoverImageUrl } from './cover-service.js';
import { coverSourceReadable } from './cover-sources.js';

const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_VERSIONS = 20;
const MAX_PICTURES = 60;

export interface WorkCoverCandidate {
  key: string;
  name: string;
  mediaType: string;
  sha256: string;
  previewUrl: string;
  source: 'work-asset' | 'thread-image' | 'upload';
  ownerRevision: number;
  pick: WorkCoverPick;
}

function earlierPick(record: WorkCoverRecord): WorkCoverPick | null {
  const origin = record.image?.origin;
  if (origin?.kind === 'upload') return { kind: 'upload', uploadUrl: origin.url };
  if (origin?.kind === 'thread-image')
    return {
      kind: 'thread-image',
      threadId: origin.threadId,
      messageId: origin.messageId,
      messageRevision: origin.messageRevision,
      item: origin.item,
      expectedUrl: origin.url,
    };
  return null;
}

/**
 * Pictures this work already owns: image assets registered on its recent fixed versions and pictures it
 * adopted before. Bounded; never a global asset library or a whole video read. Each carries its own pick.
 */
export async function listWorkCoverCandidates(
  covers: WorkCoverService,
  reference: WorkReference,
  principal: WorkPrincipal,
): Promise<WorkCoverCandidate[]> {
  await covers.read({ reference }, principal);
  const ports = covers.deps;
  const threadId = ports.threadOf(reference, principal);
  const found: WorkCoverCandidate[] = [];
  const seen = new Set<string>();
  const first = Math.max(1, reference.ownerRevision - MAX_VERSIONS + 1);
  for (let ownerRevision = reference.ownerRevision; ownerRevision >= first; ownerRevision--) {
    const version = { contentRef: reference.contentRef, ownerRevision };
    const metadata = await ports.readContext(version, principal).catch(() => null);
    for (const row of metadata?.context.assets ?? []) {
      const file = row.asset.versions.find((item) => item.id === row.versionId);
      if (!file || !PICTURE_TYPES.has(file.mediaType) || seen.has(file.sha256) || found.length >= MAX_PICTURES)
        continue;
      seen.add(file.sha256);
      const query = new URLSearchParams({ threadId });
      found.push({
        key: `asset:${ownerRevision}:${row.asset.id}`,
        name: row.asset.name,
        mediaType: file.mediaType,
        sha256: file.sha256,
        source: 'work-asset',
        ownerRevision,
        previewUrl: `/api/works/${encodeURIComponent(reference.contentRef)}/video-assets/${ownerRevision}/${metadata!.metadataRevision}/${encodeURIComponent(row.asset.id)}?${query}`,
        pick: {
          kind: 'work-asset',
          ownerRevision,
          metadataRevision: metadata!.metadataRevision,
          assetId: row.asset.id,
        },
      });
    }
  }
  for (const record of ports.store.pictures(principal.userId, reference.contentRef, MAX_PICTURES)) {
    const pick = earlierPick(record);
    const image = record.image;
    if (!pick || !image || seen.has(image.version.sha256) || found.length >= MAX_PICTURES) continue;
    // An earlier picture is offered again only while this reader can still read its own source.
    if (!(await coverSourceReadable(ports, image, principal))) continue;
    seen.add(image.version.sha256);
    found.push({
      key: `adopted:${record.reference.ownerRevision}:${record.coverRevision}`,
      name: image.name,
      mediaType: image.version.mediaType,
      sha256: image.version.sha256,
      source: pick.kind,
      ownerRevision: record.reference.ownerRevision,
      previewUrl: workCoverImageUrl(record),
      pick,
    });
  }
  return found;
}
