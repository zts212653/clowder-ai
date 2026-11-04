import type {
  MessageMediaPublicationSource,
  VideoProjectAssetVersion,
  WorkCoverImage,
  WorkCoverPick,
  WorkReference,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../types.js';

type Locator = VideoProjectAssetVersion['locator'];
const COVER_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Existing owners of each picture source; the cover owner never trusts a URL, name or directory on its own. */
export interface WorkCoverSourcePorts {
  /** Read one fixed version's video context under the same work authority. */
  readContext(
    reference: WorkReference,
    principal: WorkPrincipal,
    metadataRevision?: number,
  ): Promise<{
    metadataRevision: number;
    context: {
      assets: {
        asset: { id: string; name: string; kind: string; versions: VideoProjectAssetVersion[] };
        versionId: string;
      }[];
    };
  } | null>;
  /** Transcript read of the conversation that showed the picture. */
  authorizeThread(threadId: string, principal: WorkPrincipal): Promise<void>;
  /** Resolve one persisted message media item; recalled or changed items fail. */
  readMessageItem(
    source: MessageMediaPublicationSource,
    principal: WorkPrincipal,
  ): Promise<{ fileName: string; mediaType: string; privateImageId?: string }>;
  /** Map an owner upload file name to its registered-root locator. */
  locateUpload(fileName: string, principal: WorkPrincipal): Promise<Locator>;
  /** F063 digest of the current file at a locator. */
  inspect(
    locator: Locator,
    principal: WorkPrincipal,
  ): Promise<{ sha256: string; byteLength: number; locator: Locator }>;
}

function imageType(mediaType: string) {
  if (!COVER_MEDIA_TYPES.has(mediaType)) throw new MediaOwnerError('invalid_media');
  return mediaType;
}
const uploadType = (name: string) =>
  name.endsWith('.png')
    ? 'image/png'
    : /\.jpe?g$/.test(name)
      ? 'image/jpeg'
      : name.endsWith('.webp')
        ? 'image/webp'
        : '';

async function exactVersion(
  ports: WorkCoverSourcePorts,
  principal: WorkPrincipal,
  input: { id: string; locator: Locator; mediaType: string; ref: string },
): Promise<VideoProjectAssetVersion> {
  const file = await ports.inspect(input.locator, principal);
  const at = new Date().toISOString();
  return {
    id: input.id,
    mediaType: imageType(input.mediaType),
    byteLength: file.byteLength,
    sha256: file.sha256 as VideoProjectAssetVersion['sha256'],
    locator: file.locator,
    recordedAt: at,
    origin: { kind: 'imported', actor: principal.actor, at, refs: [input.ref] },
  };
}

/** Resolve a pick to one exact picture now; the record keeps these bytes' identity, not the pick. */
export async function resolveCoverPick(
  ports: WorkCoverSourcePorts,
  work: WorkReference,
  pick: WorkCoverPick,
  principal: WorkPrincipal,
): Promise<WorkCoverImage> {
  if (pick.kind === 'work-asset') {
    const reference = { contentRef: work.contentRef, ownerRevision: pick.ownerRevision };
    const metadata = await ports.readContext(reference, principal, pick.metadataRevision);
    const row = metadata?.context.assets.find((item) => item.asset.id === pick.assetId);
    const version = row?.asset.versions.find((item) => item.id === row.versionId);
    if (!row || !version) throw new MediaOwnerError('media_unavailable');
    imageType(version.mediaType);
    const file = await ports.inspect(version.locator, principal);
    if (file.sha256 !== version.sha256 || file.byteLength !== version.byteLength)
      throw new MediaOwnerError('publication_changed');
    return {
      name: row.asset.name,
      version,
      origin: {
        kind: 'work-asset',
        reference,
        metadataRevision: pick.metadataRevision,
        assetId: pick.assetId,
        assetName: row.asset.name,
        assetKind: row.asset.kind,
      },
    };
  }
  if (pick.kind === 'thread-image') {
    // A cat reads only its own execution conversation; a person reads conversations they can open.
    if (principal.actor.kind === 'cat' && pick.threadId !== principal.threadId)
      throw new MediaOwnerError('access_denied');
    await ports.authorizeThread(pick.threadId, principal);
    const { kind: _pick, ...coordinate } = pick;
    const item = await ports.readMessageItem({ kind: 'message', ...coordinate }, principal);
    if (item.privateImageId) throw new MediaOwnerError('invalid_media');
    const locator = await ports.locateUpload(item.fileName, principal);
    return {
      name: item.fileName,
      version: await exactVersion(ports, principal, {
        id: `message:${pick.threadId}:${pick.messageId}`,
        locator,
        mediaType: item.mediaType,
        ref: `message:${pick.threadId}:${pick.messageId}`,
      }),
      origin: {
        kind: 'thread-image',
        threadId: pick.threadId,
        messageId: pick.messageId,
        messageRevision: pick.messageRevision,
        item: pick.item,
        url: pick.expectedUrl,
      },
    };
  }
  // Only the person at this computer uploads; a cat cannot adopt someone's upload by its URL.
  if (principal.actor.kind !== 'human') throw new MediaOwnerError('access_denied');
  const fileName = pick.uploadUrl.slice('/uploads/'.length);
  const locator = await ports.locateUpload(fileName, principal);
  return {
    name: fileName,
    version: await exactVersion(ports, principal, {
      id: `upload:${fileName}`,
      locator,
      mediaType: uploadType(fileName),
      ref: `human-upload:${pick.uploadUrl}`,
    }),
    origin: { kind: 'upload', url: pick.uploadUrl },
  };
}

/**
 * Whether the adopted picture is still readable by this caller from its own source. A lost source or
 * withdrawn authority both mean "unavailable": the choice stays and no other picture is substituted.
 */
export async function coverSourceReadable(
  ports: WorkCoverSourcePorts,
  image: WorkCoverImage,
  principal: WorkPrincipal,
): Promise<boolean> {
  try {
    const origin = image.origin;
    if (origin.kind === 'work-asset') {
      const metadata = await ports.readContext(origin.reference, principal, origin.metadataRevision);
      const row = metadata?.context.assets.find((item) => item.asset.id === origin.assetId);
      const version = row?.asset.versions.find((item) => item.id === row.versionId);
      if (
        !version ||
        version.sha256 !== image.version.sha256 ||
        version.locator.rootId !== image.version.locator.rootId ||
        version.locator.path !== image.version.locator.path
      )
        return false;
    } else if (origin.kind === 'thread-image') {
      await ports.authorizeThread(origin.threadId, principal);
      await ports.readMessageItem(
        {
          kind: 'message',
          threadId: origin.threadId,
          messageId: origin.messageId,
          messageRevision: origin.messageRevision,
          item: origin.item,
          expectedUrl: origin.url,
        },
        principal,
      );
    }
    const file = await ports.inspect(image.version.locator, principal);
    return file.sha256 === image.version.sha256 && file.byteLength === image.version.byteLength;
  } catch {
    return false;
  }
}
