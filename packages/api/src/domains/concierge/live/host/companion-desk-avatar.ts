import { catRegistry } from '@cat-cafe/shared';
import sharp from 'sharp';

/** 20px round on the desk; 40px covers a 2x screen. */
const AVATAR_PX = 40;
/** Source avatars are small PNG/JPEG files; anything larger is not an avatar. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export interface DeskAvatarImage {
  mediaType: 'image/png';
  dataBase64: string;
  width: number;
  height: number;
}

/**
 * F335 交付三：the bringer's avatar on the desk bubble. Only a registered cat's configured avatar, resolved through the
 * Host's traversal-safe media path resolver, shrunk to a small PNG. Anything else: no avatar (the name still shows).
 */
export function createDeskAvatarReader(resolvePath: (url: string) => string | undefined) {
  return async (catId: string): Promise<DeskAvatarImage | null> => {
    const avatar = catRegistry.tryGet(catId)?.config.avatar;
    if (typeof avatar !== 'string' || !avatar.startsWith('/avatars/')) return null;
    const file = resolvePath(avatar);
    if (!file) return null;
    try {
      const { size } = await import('node:fs/promises').then((fs) => fs.stat(file));
      if (size > MAX_SOURCE_BYTES) return null;
      const png = await sharp(file).resize(AVATAR_PX, AVATAR_PX, { fit: 'cover' }).png().toBuffer();
      return { mediaType: 'image/png', dataBase64: png.toString('base64'), width: AVATAR_PX, height: AVATAR_PX };
    } catch {
      return null;
    }
  };
}
