import { readFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

/** F211 REG3 Layer C: an Antigravity `SendUserCascadeMessage` media item (Connect JSON wire shape). */
export interface AntigravityMediaItem {
  mimeType: string;
  /** Base64-encoded image bytes (protobuf `bytes` → base64 string on the Connect JSON wire). */
  inlineData: string;
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * F211 REG3 Layer C: read local image files into Antigravity media items so a
 * Cat-Cafe-dispatched cascade can actually SEE the image (base64 bytes delivered
 * via `SendUserCascadeMessage.media`), instead of only a textual path hint that
 * Antigravity's `view_file` cannot render. Unsupported extensions and unreadable
 * paths are skipped (best-effort — a missing image must not break the invocation).
 */
export async function buildImageMediaItems(imagePaths: readonly string[]): Promise<AntigravityMediaItem[]> {
  const items: AntigravityMediaItem[] = [];
  for (const imagePath of imagePaths) {
    const mimeType = IMAGE_EXT_TO_MIME[extname(imagePath).toLowerCase()];
    if (!mimeType) continue;
    try {
      const bytes = await readFile(imagePath);
      items.push({ mimeType, inlineData: bytes.toString('base64') });
    } catch {
      // Skip unreadable image — best-effort delivery.
    }
  }
  return items;
}

/**
 * Build prompt hints for local image paths.
 * These are path references for tool access, not binary attachments.
 */
export function buildLocalImagePathHints(imagePaths: readonly string[]): string {
  if (imagePaths.length === 0) return '';
  return imagePaths.map((p) => `[Local image path: ${p}]`).join('\n');
}

/**
 * Append local image path hints to an existing prompt.
 */
export function appendLocalImagePathHints(prompt: string, imagePaths: readonly string[]): string {
  const hints = buildLocalImagePathHints(imagePaths);
  if (!hints) return prompt;
  return `${prompt}\n\n${hints}`;
}

/**
 * Extract unique directory list from image paths for CLI workspace include flags.
 */
export function collectImageAccessDirectories(imagePaths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const imagePath of imagePaths) {
    const dir = dirname(imagePath);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}
