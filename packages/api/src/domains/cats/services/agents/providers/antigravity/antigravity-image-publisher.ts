import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { ALLOWED_IMAGE_MIMES, type SupportedImageMime } from '../../../../../../utils/image-storage.js';
import { type PublishedGeneratedImage, publishGeneratedImage } from '../generated-image-publication.js';
import type { TrajectoryStep } from './AntigravityBridge.js';

const log = createModuleLogger('antigravity-image-publisher');

const EXT_TO_MIME: Record<string, SupportedImageMime> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function extractAbsoluteImagePaths(text: string | undefined | null): string[] {
  if (!text) return [];
  const paths: string[] = [];
  for (const rawToken of text.split(/[\s"'`()[\]{}<>,;]+/)) {
    // Antigravity generate_image emits "saved at <path>." with a trailing period;
    // strip any trailing sentence punctuation before the extension check.
    const token = rawToken.replace(/[.,;:!?]+$/, '');
    if (token.startsWith('/') && /\.(?:png|jpe?g|gif|webp)$/i.test(token)) {
      paths.push(token);
    }
  }
  return [...new Set(paths)];
}

const IMAGE_GEN_TOOL_NAMES = new Set(['image_gen', 'generate_image', 'create_image']);

export function collectImagePathsFromSteps(steps: TrajectoryStep[]): string[] {
  const paths = new Set<string>();
  for (const step of steps) {
    const toolName = step.toolResult?.toolName ?? step.toolCall?.toolName ?? step.metadata?.toolCall?.name;
    if (toolName && IMAGE_GEN_TOOL_NAMES.has(toolName)) {
      for (const p of extractAbsoluteImagePaths(step.toolResult?.output)) paths.add(p);
    }
  }
  return [...paths];
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export interface AntigravityImagePublishOptions {
  candidatePaths: string[];
  cascadeId: string;
  uploadDir?: string;
  maxAgeMs?: number;
}

export async function publishAntigravityImages(
  options: AntigravityImagePublishOptions,
): Promise<PublishedGeneratedImage[]> {
  const results: PublishedGeneratedImage[] = [];

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cutoff = Date.now() - maxAgeMs;

  for (const filePath of options.candidatePaths) {
    if (filePath.includes('/uploads/')) continue;

    const ext = extname(filePath).toLowerCase();
    const mime = EXT_TO_MIME[ext];
    if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) continue;

    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < cutoff) continue;
    } catch {
      continue;
    }

    const pathHash = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
    try {
      const published = await publishGeneratedImage({
        sourcePath: filePath,
        mimeType: mime,
        publicationKey: `antigravity-${options.cascadeId}-${pathHash}-${filePath.split('/').pop()}`,
        provider: 'antigravity',
        toolName: 'image_gen',
        uploadDir: options.uploadDir,
        title: 'antigravity:image_gen',
        alt: 'generated image',
      });
      if (published.isNew) results.push(published);
    } catch (err) {
      log.warn({ filePath, err }, 'Failed to publish antigravity generated image');
    }
  }

  return results;
}

// ─── F172 Phase G: GENERATE_IMAGE step type → brain dir scanner ──────────────
//
// Antigravity's built-in `generate_image` does NOT surface a tool_result with a
// path string. It produces a dedicated `CORTEX_STEP_TYPE_GENERATE_IMAGE` step
// whose payload sits in `step.generateImage` and the actual file lands at:
//
//     ~/.gemini/antigravity/brain/<cascadeId>/<imageName>_<unixMs>.<ext>
//
// So Phase F's `extractAbsoluteImagePaths` path was a no-op for real cascades —
// it had nothing to extract. Phase G scans the brain directory using the
// imageName from each DONE GENERATE_IMAGE step, then defers to the shared
// publication contract.

export interface GenerateImageStepInfo {
  imageName: string;
  /** Optional MIME hint from `generatedMedia.mimeType` (e.g. `image/jpeg`). */
  mimeHint?: string;
}

export function collectGenerateImageSteps(steps: TrajectoryStep[]): GenerateImageStepInfo[] {
  const out: GenerateImageStepInfo[] = [];
  for (const step of steps) {
    if (step.type !== 'CORTEX_STEP_TYPE_GENERATE_IMAGE') continue;
    if (step.status !== 'CORTEX_STEP_STATUS_DONE') continue;
    const imageName = step.generateImage?.imageName?.trim();
    if (!imageName) continue;
    out.push({ imageName, mimeHint: step.generateImage?.generatedMedia?.mimeType });
  }
  return out;
}

export interface AntigravityBrainScanOptions {
  steps: TrajectoryStep[];
  cascadeId: string;
  uploadDir?: string;
  brainHome?: string;
  maxAgeMs?: number;
}

const DEFAULT_BRAIN_HOME = join(homedir(), '.gemini', 'antigravity', 'brain');

export async function scanAndPublishAntigravityBrainImages(
  options: AntigravityBrainScanOptions,
): Promise<PublishedGeneratedImage[]> {
  const stepInfos = collectGenerateImageSteps(options.steps);
  if (stepInfos.length === 0) return [];

  const brainHome = options.brainHome ?? process.env.ANTIGRAVITY_BRAIN_HOME ?? DEFAULT_BRAIN_HOME;
  const cascadeDir = join(brainHome, options.cascadeId);

  let entries: string[];
  try {
    entries = await readdir(cascadeDir);
  } catch {
    return [];
  }

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cutoff = Date.now() - maxAgeMs;
  const results: PublishedGeneratedImage[] = [];

  for (const info of stepInfos) {
    // Brain files follow strict `<imageName>_<unixMs>.<ext>` shape. Use a
    // regex anchored on the timestamp suffix to avoid prefix collisions
    // (e.g. imageName="wanted" must NOT match "wanted_legacy_<ts>.png" —
    // cloud review P2 on PR #1365).
    const escapedName = info.imageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const strictPattern = new RegExp(`^${escapedName}_(\\d+)\\.(?:png|jpe?g|gif|webp)$`, 'i');
    const matches = entries.filter((name) => {
      const ext = extname(name).toLowerCase();
      if (!(ext in EXT_TO_MIME)) return false;
      return strictPattern.test(name);
    });

    for (const filename of matches) {
      const ext = extname(filename).toLowerCase();
      const mime = EXT_TO_MIME[ext];
      if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) continue;

      const fullPath = join(cascadeDir, filename);
      try {
        const fileStat = await stat(fullPath);
        if (fileStat.mtimeMs < cutoff) continue;
      } catch {
        continue;
      }

      try {
        const published = await publishGeneratedImage({
          sourcePath: fullPath,
          mimeType: mime,
          publicationKey: `antigravity-${options.cascadeId}-${filename}`,
          provider: 'antigravity',
          toolName: 'generate_image',
          uploadDir: options.uploadDir,
          title: 'antigravity:generate_image',
          alt: 'generated image',
        });
        if (published.isNew) results.push(published);
      } catch (err) {
        log.warn({ fullPath, err }, 'Failed to publish antigravity brain-scanned image');
      }
    }
  }

  return results;
}
