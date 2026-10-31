import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_FILE_SIZE,
  type SupportedImageMime,
} from '../../../../../utils/image-storage.js';
import {
  type CodexNativeImageOrigin,
  type CodexNativeImageSource,
  codexNativeImageOutputs,
} from './codex-native-image-origin.js';
import { type PublishedGeneratedImage, publishGeneratedImage } from './generated-image-publication.js';

const log = createModuleLogger('codex-image-scanner');

export const CODEX_IMAGE_MIME_BY_EXTENSION: Record<string, SupportedImageMime> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface CodexImageScanOptions {
  codexSessionId: string;
  uploadDir?: string;
  codexHome?: string;
  nativeSource?: CodexNativeImageSource;
}

export async function scanAndPublishCodexImages(options: CodexImageScanOptions): Promise<PublishedGeneratedImage[]> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
  const sessionDir = join(codexHome, 'generated_images', options.codexSessionId);

  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return [];
  }

  const native = options.nativeSource
    ? codexNativeImageOutputs(options.nativeSource, options.codexSessionId)
    : undefined;
  const imageFiles = entries.filter((name) => {
    const ext = extname(name).toLowerCase();
    return (
      ext in CODEX_IMAGE_MIME_BY_EXTENSION &&
      (native === undefined || native.some((output) => resolve(output.sourcePath) === resolve(sessionDir, name)))
    );
  });

  if (imageFiles.length === 0) return [];

  const results: PublishedGeneratedImage[] = [];
  for (const filename of imageFiles) {
    const ext = extname(filename).toLowerCase();
    const mime = CODEX_IMAGE_MIME_BY_EXTENSION[ext];
    if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) continue;

    try {
      const origin = native?.find((output) => resolve(output.sourcePath) === resolve(sessionDir, filename))?.origin;
      if (
        native &&
        native.filter((output) => resolve(output.sourcePath) === resolve(sessionDir, filename)).length > 1
      ) {
        log.warn({ filename, sessionDir }, 'Conflicting native generation ownership for one image');
        continue;
      }
      if (native !== undefined && (!origin || !(await matchesNativeOutput(sessionDir, filename, origin)))) continue;
      const published = await publishGeneratedImage({
        sourcePath: join(sessionDir, filename),
        mimeType: mime,
        publicationKey: `codex-${options.codexSessionId}-${filename}`,
        provider: 'codex',
        toolName: 'image_gen',
        uploadDir: options.uploadDir,
        title: 'codex:image_gen',
        alt: 'generated image',
        ...(origin ? { nativeOrigin: origin } : {}),
      });
      if (published.isNew || origin) results.push(published);
    } catch (err) {
      log.warn({ filename, sessionDir, err }, 'Failed to publish codex generated image');
    }
  }

  return results;
}

async function matchesNativeOutput(sessionDir: string, filename: string, origin: CodexNativeImageOrigin) {
  if (basename(filename, extname(filename)) !== origin.itemId) return false;
  const sourcePath = await realpath(join(sessionDir, filename));
  if (dirname(sourcePath) !== (await realpath(sessionDir))) return false;
  if ((await stat(sourcePath)).size > MAX_IMAGE_FILE_SIZE) return false;
  return (
    `sha256:${createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex')}` === origin.blobDigest
  );
}
