import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { RichBlock } from '@cat-cafe/shared';
import { isAbsoluteFilesystemPath } from '@cat-cafe/shared/utils';
import { guessMime } from '../../../../workspace/workspace-file-read.js';
import { resolveWorkspaceAbsolutePath } from '../../../../workspace/workspace-path-resolution.js';

const MEDIA_URL_HINT =
  'Use /api/workspace/file/raw?worktreeId=<registered-id>&path=<encoded-relative-path>, /uploads/..., /avatars/..., or an https:// image URL. Use publish_image for durable local PNG publication.';
const API_MEDIA_PREFIXES = [
  '/uploads/',
  '/avatars/',
  '/api/workspace/file/raw?',
  '/api/connector-media/',
  '/api/plugins/chatgpt-dot/images/',
];

type RichMediaResolution =
  | { ok: true; blocks: RichBlock[] }
  | { ok: false; code: 'RICH_MEDIA_URL_INVALID'; error: string; hint: string };

/** Both callback transports share this admission before they publish any gallery. */
export async function resolveRichMediaBlocks(blocks: readonly RichBlock[]): Promise<RichMediaResolution> {
  const resolved: RichBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== 'media_gallery') {
      resolved.push(block);
      continue;
    }
    const items = [];
    for (const [index, item] of block.items.entries()) {
      const url = item.url.trim();
      try {
        if (
          API_MEDIA_PREFIXES.some((prefix) => url.startsWith(prefix)) ||
          /^https?:\/\//i.test(url) ||
          /^data:image\//i.test(url)
        ) {
          items.push({ ...item, url });
          continue;
        }
        if (!isAbsoluteFilesystemPath(url))
          throw new Error('Expected a supported image URL or a registered workspace absolute image path');
        const target = await resolveWorkspaceAbsolutePath(url);
        if (target.kind !== 'file' || !guessMime(target.path).startsWith('image/'))
          throw new Error('Local path must be an image file');
        await access(url, constants.R_OK);
        if ((await stat(url)).size > 10 * 1024 * 1024)
          throw new Error('Local image exceeds the 10MiB workspace preview limit');
        items.push({
          ...item,
          url: `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: target.worktreeId, path: target.path })}`,
        });
      } catch (error) {
        return {
          ok: false,
          code: 'RICH_MEDIA_URL_INVALID',
          error: `media_gallery ${block.id} items[${index}].url: ${error instanceof Error ? error.message : 'Image path cannot be read'}`,
          hint: MEDIA_URL_HINT,
        };
      }
    }
    resolved.push({ ...block, items });
  }
  return { ok: true, blocks: resolved };
}
