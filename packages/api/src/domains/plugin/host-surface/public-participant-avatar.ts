import sharp from 'sharp';
import { readBoundedPackageFile } from '../external-runtime/bounded-package-file.js';

export interface ParticipantAvatarRoots {
  readonly avatars: string;
  readonly uploads: string;
}
/** Only a small decoded thumbnail crosses the port; Host paths and original bytes stay private. */
export async function publicParticipantAvatar(
  value: string | undefined,
  roots: ParticipantAvatarRoots,
): Promise<string | undefined> {
  const match = value?.match(/^\/(avatars|uploads)\/([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|jpe?g|webp))$/);
  if (!match?.[2]) return undefined;
  try {
    const root = match[1] === 'avatars' ? roots.avatars : roots.uploads;
    const bytes = await readBoundedPackageFile(root, match[2], 10_000_000);
    const thumbnail = await sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error' })
      .rotate()
      .resize(48, 48, { fit: 'cover' })
      .webp({ quality: 45 })
      .toBuffer();
    const encoded = `data:image/webp;base64,${thumbnail.toString('base64')}`;
    return encoded.length <= 1_200 ? encoded : undefined;
  } catch {
    return undefined;
  }
}
