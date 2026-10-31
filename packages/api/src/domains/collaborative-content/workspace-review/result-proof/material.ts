import { MIMEType } from 'node:util';
import type { VideoProjectDocumentV1 } from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../errors.js';

/** Encoded bytes fix intrinsic facts; only decoder kind and applied orientation affect material semantics. */
export function assetMaterial(document: VideoProjectDocumentV1, id: string) {
  const version = document.assets.flatMap((asset) => asset.versions).find((version) => version.id === id);
  if (!version) throw new WorkspaceContentReviewError('invalid_action');
  let mime: MIMEType;
  try {
    mime = new MIMEType(version.mediaType);
  } catch {
    throw new WorkspaceContentReviewError('invalid_action');
  }
  // Parameters, locators, version IDs and static-image duration are not render inputs.
  return { sha256: version.sha256, mediaType: mime.essence, rotation: version.rotation ?? 0 };
}
