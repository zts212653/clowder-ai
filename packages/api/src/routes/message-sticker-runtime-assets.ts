import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMonorepoRoot } from '../utils/monorepo-root.js';

// Keep this list file-scoped. The source directory also contains prompts,
// private reference paths, an archive zip and four artwork files that are not
// part of the approved runtime catalogue. The outbound sync guard matches
// these exact literals to the exact public projection in sync-manifest.yaml.
const COLLABORATION_STICKER_RUNTIME_ASSET_PATHS = [
  'docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/yanyan-working.png',
  'docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/shuoshuo-idea.png',
  'docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/momo-recall.png',
  'docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/momo-cheer.png',
] as const;

const collaborationStickerDirectory = dirname(COLLABORATION_STICKER_RUNTIME_ASSET_PATHS[0]);

if (COLLABORATION_STICKER_RUNTIME_ASSET_PATHS.some((path) => dirname(path) !== collaborationStickerDirectory)) {
  throw new Error('Approved collaboration sticker assets must share one source directory');
}

export function resolveMessageStickerDirectories() {
  const monorepoRoot = findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
  return {
    memory: join(monorepoRoot, 'packages/web/public/f321/stickers'),
    collaboration: join(monorepoRoot, collaborationStickerDirectory),
  };
}
