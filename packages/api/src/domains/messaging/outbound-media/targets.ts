/**
 * F202 W2-5b — which media a Host message carries, as a list of targets to materialize.
 *
 * Pure planning over `extra.rich.blocks`; nothing here reads a file or calls a service. Each target
 * owns one element id — `el_<messageId>_<block + 1>` for an audio or file block,
 * `el_<messageId>_<block + 1>_<item>` for a gallery image — so a retry, a restart and the snapshot
 * all project the same element for the same block. Only `url`, `fileName`, `mimeType`, `text`,
 * `speaker`, `alt` and `caption` are read: generated-image galleries carry a provenance record with
 * the source path and the prompt, and the whole block is never copied anywhere.
 */
import { basename, extname } from 'node:path';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

export type HostMediaType = 'audio' | 'file' | 'image';

export type OutboundMediaTarget =
  | {
      readonly kind: 'media';
      readonly elementId: string;
      readonly type: HostMediaType;
      readonly url: string;
      readonly fileName?: string;
      readonly mimeType?: string;
      readonly label: string;
    }
  | {
      readonly kind: 'speech';
      readonly elementId: string;
      readonly blockId: string;
      readonly text: string;
      readonly speaker?: string;
    };

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

export function mimeTypeForName(name: string | undefined): string | undefined {
  return name ? MIME_BY_EXTENSION[extname(name).toLowerCase()] : undefined;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION).map(([extension, mime]) => [mime, extension]),
);

export function extensionForMimeType(mimeType: string | undefined): string | undefined {
  return mimeType ? EXTENSION_BY_MIME[mimeType] : undefined;
}

/**
 * The base name of a file name or path, whatever separator style it uses. The callback schema
 * accepts any non-empty `fileName`, and a Windows path has no `/` for the POSIX `basename` to cut
 * at — so both separators are normalized first (review P1s, comments 5828208840 / 5828779117).
 */
function baseNameOf(name: string): string {
  return basename(name.replace(/\\/g, '/')).trim();
}

/** A file name the wire accepts (1..512) and that carries an extension, or nothing. */
export function usableFileName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = Array.from(baseNameOf(name)).slice(-512).join('');
  return trimmed.length > 0 && extname(trimmed).length > 1 ? trimmed : undefined;
}

/** The wire label for a file name: its base name only, never a path (fallback and link text). */
function fileLabel(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = baseNameOf(name);
  return base.length > 0 ? base : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function planOutboundMedia(msg: StoredMessage): OutboundMediaTarget[] {
  const blocks = msg.extra?.rich?.blocks ?? [];
  const targets: OutboundMediaTarget[] = [];
  blocks.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const block = raw as unknown as Record<string, unknown>;
    const elementId = `el_${msg.id}_${index + 1}`;
    const blockId = stringField(block, 'id') ?? elementId;
    if (block.kind === 'audio') {
      const url = stringField(block, 'url');
      const text = stringField(block, 'text');
      if (url) {
        const mimeType = stringField(block, 'mimeType');
        const label = stringField(block, 'title') ?? 'audio';
        targets.push({ kind: 'media', elementId, type: 'audio', url, label, ...(mimeType ? { mimeType } : {}) });
      } else if (text) {
        const speaker = stringField(block, 'speaker');
        targets.push({ kind: 'speech', elementId, blockId, text, ...(speaker ? { speaker } : {}) });
      }
      return;
    }
    if (block.kind === 'file') {
      const url = stringField(block, 'url');
      if (!url) return;
      const fileName = usableFileName(stringField(block, 'fileName'));
      const mimeType = stringField(block, 'mimeType');
      targets.push({
        kind: 'media',
        elementId,
        type: 'file',
        url,
        label: fileLabel(stringField(block, 'fileName')) ?? 'file',
        ...(fileName ? { fileName } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
      return;
    }
    if (block.kind === 'media_gallery' && Array.isArray(block.items)) {
      block.items.forEach((rawItem: unknown, item: number) => {
        if (!rawItem || typeof rawItem !== 'object') return;
        const entry = rawItem as Record<string, unknown>;
        if (entry.type !== undefined && entry.type !== 'image') return; // galleries only send images
        const url = stringField(entry, 'url');
        if (!url) return;
        const label = stringField(entry, 'alt') ?? stringField(entry, 'caption') ?? 'image';
        targets.push({ kind: 'media', elementId: `${elementId}_${item}`, type: 'image', url, label });
      });
    }
  });
  return targets;
}
