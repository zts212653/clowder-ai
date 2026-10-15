import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';
import { MAX_IMAGE_FILE_SIZE } from '../../../../../../utils/image-storage.js';
import { getDefaultUploadDir } from '../../../../../../utils/upload-paths.js';
import { AcpImageInputError, requireAcpImageCapability } from './acp-prompt-content.js';
import type { AcpContentBlock, AcpPromptCapabilities } from './types.js';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGES = 5; // Same image-count ceiling as multipart message admission.
const invalid = () =>
  new AcpImageInputError('image_input_invalid', '图片附件路径或格式无效，请重新上传 PNG/JPEG/GIF/WebP 图片。');
const tooLarge = () =>
  new AcpImageInputError('image_input_too_large', '图片附件超过大小或数量限制，请减少附件后重试。');
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Only platform uploads are dereferenced; no remote fetch or arbitrary native paths. */
export async function readAcpImageBlocks(
  content: readonly MessageContent[] | undefined,
  capabilities?: AcpPromptCapabilities,
  signal?: AbortSignal,
): Promise<readonly AcpContentBlock[]> {
  const images = content?.filter((block) => block.type === 'image') ?? [];
  if (images.length === 0) return [];
  requireAcpImageCapability(capabilities);
  if (images.length > MAX_IMAGES) throw tooLarge();
  let root: string;
  try {
    root = await realpath(getDefaultUploadDir(process.env.UPLOAD_DIR));
  } catch {
    throw new AcpImageInputError('image_input_unavailable', '图片附件无法读取，请重新上传。');
  }
  const blocks: AcpContentBlock[] = [];
  for (const image of images) {
    signal?.throwIfAborted();
    if (typeof image.url !== 'string' || !image.url.startsWith('/uploads/')) throw invalid();
    let path: string;
    try {
      path = resolve(root, decodeURIComponent(image.url.slice('/uploads/'.length)));
    } catch {
      throw invalid();
    }
    const mimeType = MIME_TYPES[extname(path).toLowerCase()];
    if (!mimeType || !inside(root, path)) throw invalid();
    try {
      const canonical = await realpath(path);
      if (!inside(root, canonical)) throw invalid();
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw invalid();
        if (info.size > MAX_IMAGE_FILE_SIZE) throw tooLarge();
        // Bounded even when a file grows after stat; never silently truncate it.
        const buffer = Buffer.alloc(MAX_IMAGE_FILE_SIZE + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_IMAGE_FILE_SIZE) throw tooLarge();
        if (length === 0) throw invalid();
        blocks.push(Object.freeze({ type: 'image', mimeType, data: buffer.subarray(0, length).toString('base64') }));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof AcpImageInputError || signal?.aborted) throw error;
      throw new AcpImageInputError('image_input_unavailable', '图片附件无法读取，请重新上传。');
    }
  }
  return Object.freeze(blocks);
}

export function withAcpImages(text: string, images: readonly AcpContentBlock[]): string | readonly AcpContentBlock[] {
  return images.length === 0 ? text : [{ type: 'text', text }, ...images];
}
