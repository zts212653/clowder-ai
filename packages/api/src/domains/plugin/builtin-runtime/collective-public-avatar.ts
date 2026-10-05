import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { findMonorepoRoot } from '../../../utils/monorepo-root.js';
import { getDefaultUploadDir } from '../../../utils/upload-paths.js';

interface AvatarRoots {
  readonly avatars: string;
  readonly uploads: string;
}

export function collectiveAvatarRoots(): AvatarRoots {
  return {
    avatars: join(findMonorepoRoot(), 'packages/web/public/avatars'),
    uploads: getDefaultUploadDir(process.env.UPLOAD_DIR),
  };
}

/** Portable, bounded thumbnail; no local Host URL or original upload path crosses the Service boundary. */
export async function publicCollectiveAvatar(
  value: string | undefined,
  roots: AvatarRoots,
): Promise<string | undefined> {
  const match = value?.match(/^\/(avatars|uploads)\/([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|jpe?g|webp))$/);
  if (!match) return undefined;
  const root = match[1] === 'avatars' ? roots.avatars : roots.uploads;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(resolve(root, match[2] ?? ''));
    const pathFromRoot = relative(canonicalRoot, canonicalFile);
    if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) return undefined;
    if ((await stat(canonicalFile)).size > 10_000_000) return undefined;
    const bytes = await readFile(canonicalFile);
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
