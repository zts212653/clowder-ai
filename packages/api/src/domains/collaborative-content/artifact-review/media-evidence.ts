import {
  type ArtifactReviewAnchor,
  artifactReviewMediaEvidenceSchema,
  type ReviewedMediaAsset,
} from '@cat-cafe/shared';
import sharp from 'sharp';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { assertMediaAnchor } from './anchors.js';
import { ArtifactReviewError } from './errors.js';

/** Read retained owner bytes, never the mutable Workspace path or the first GIF frame by accident. */
export async function readReviewMediaEvidence(
  media: Pick<PublishedMediaService, 'openAsset'>,
  asset: ReviewedMediaAsset,
  principal: MediaReviewPrincipal,
  anchor?: ArtifactReviewAnchor,
) {
  if (anchor) assertMediaAnchor(anchor, asset.media);
  const original = await media.openAsset(asset, principal, 'snapshot');
  try {
    const images: { purpose: 'frame' | 'crop'; mimeType: 'image/png'; data: string }[] = [];
    if (
      asset.media.kind === 'image' &&
      ((asset.media.animation?.frameCount ?? 1) <= 1 || (anchor && anchor.kind !== 'video-range'))
    ) {
      if (original.byteLength > 10 * 1024 * 1024) throw new ArtifactReviewError('invalid_action');
      const bytes = await original.handle.readFile();
      const frameIndex = anchor && anchor.kind !== 'video-range' ? (anchor.frameIndex ?? 0) : 0;
      const decode = () =>
        sharp(bytes, { page: frameIndex, pages: 1, limitInputPixels: 64_000_000, failOn: 'error' })
          .timeout({ seconds: 5 })
          .rotate();
      const full = await decode().resize(768, 768, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      images.push({ purpose: 'frame', mimeType: 'image/png', data: full.toString('base64') });
      if (anchor && anchor.kind !== 'video-range') {
        const { width, height } = asset.media;
        const left = Math.max(
          0,
          Math.min(width - 1, Math.floor(anchor.kind === 'image-region' ? anchor.x : anchor.x - 64)),
        );
        const top = Math.max(
          0,
          Math.min(height - 1, Math.floor(anchor.kind === 'image-region' ? anchor.y : anchor.y - 64)),
        );
        const right = Math.min(width, anchor.kind === 'image-region' ? Math.ceil(anchor.x + anchor.width) : left + 128);
        const bottom = Math.min(
          height,
          anchor.kind === 'image-region' ? Math.ceil(anchor.y + anchor.height) : top + 128,
        );
        const crop = await decode()
          .extract({ left, top, width: right - left, height: bottom - top })
          .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        images.push({ purpose: 'crop', mimeType: 'image/png', data: crop.toString('base64') });
      }
    }
    return artifactReviewMediaEvidenceSchema.parse({
      asset,
      originalPath: original.path,
      ...(anchor ? { anchor } : {}),
      images,
      trust: 'untrusted_review_data',
    });
  } finally {
    await original.handle.close();
  }
}
