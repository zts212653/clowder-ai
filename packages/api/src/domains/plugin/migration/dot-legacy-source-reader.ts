import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { PLUGIN_HOST_ENTRIES, pluginHostRoot } from '../host-inventory/plugin-host-layout.js';
import {
  type LegacyDotConnectionState,
  type LegacyDotDispatchRecord,
  legacyDotConnectionStateSchema,
  legacyDotDispatchRecordSchema,
} from './dot-legacy-schemas.js';

const JSON_LIMIT_BYTES = 1024 * 1024;
const PNG_LIMIT_BYTES = 10 * 1024 * 1024;
const dispatchFile = /^(dot_evt_[a-f0-9]{64})\.json$/;
const imageFile = /^(dot_img_[a-f0-9]{64})\.json$/;

export const legacyDotImageMetadataSchema = z
  .object({
    id: z.string().regex(/^dot_img_[a-f0-9]{64}$/),
    ownerUserId: z.string().min(1),
    threadId: z.string().min(1),
    eventId: z.string().regex(/^dot_evt_[a-f0-9]{64}$/),
    publicationKey: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    messageId: z.string().nullable(),
    alt: z.string(),
  })
  .strict();

export type LegacyDotImageMetadata = z.infer<typeof legacyDotImageMetadataSchema>;

export interface DotLegacySourcePaths {
  readonly connection: string;
  readonly dispatches: string;
  readonly images: string;
  readonly imageFiles: string;
}

export function dotLegacySourcePaths(projectRoot: string): DotLegacySourcePaths {
  const root = pluginHostRoot(projectRoot);
  const images = resolve(root, PLUGIN_HOST_ENTRIES.dotImages);
  return {
    connection: resolve(root, PLUGIN_HOST_ENTRIES.dotConnection),
    dispatches: resolve(root, PLUGIN_HOST_ENTRIES.dotDispatches),
    images,
    imageFiles: join(images, 'files'),
  };
}

export class DotLegacySourceReader {
  constructor(private readonly paths: DotLegacySourcePaths) {}

  async connection(): Promise<LegacyDotConnectionState | null> {
    const raw = await readOptionalStable(this.paths.connection, JSON_LIMIT_BYTES);
    return raw ? legacyDotConnectionStateSchema.parse(JSON.parse(raw.toString('utf8'))) : null;
  }

  async dispatches(): Promise<readonly LegacyDotDispatchRecord[]> {
    const ids = await matchingIds(this.paths.dispatches, dispatchFile);
    const records: LegacyDotDispatchRecord[] = [];
    for (const id of ids) {
      const raw = await readStable(join(this.paths.dispatches, `${id}.json`), JSON_LIMIT_BYTES);
      const record = legacyDotDispatchRecordSchema.parse(JSON.parse(raw.toString('utf8')));
      if (record.eventId !== id) throw new Error('dot_legacy_dispatch_identity_mismatch');
      records.push(record);
    }
    return records;
  }

  async imageMetadata(): Promise<readonly LegacyDotImageMetadata[]> {
    const ids = await matchingIds(this.paths.images, imageFile);
    const records: LegacyDotImageMetadata[] = [];
    for (const id of ids) {
      const raw = await readStable(join(this.paths.images, `${id}.json`), JSON_LIMIT_BYTES);
      const metadata = legacyDotImageMetadataSchema.parse(JSON.parse(raw.toString('utf8')));
      if (metadata.id !== id) throw new Error('dot_legacy_image_identity_mismatch');
      records.push(metadata);
    }
    return records;
  }

  async imageBytes(id: string): Promise<Buffer> {
    if (!/^dot_img_[a-f0-9]{64}$/.test(id)) throw new Error('dot_legacy_image_id_invalid');
    return readStable(join(this.paths.imageFiles, `${id}.png`), PNG_LIMIT_BYTES);
  }
}

async function matchingIds(directory: string, pattern: RegExp): Promise<readonly string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => pattern.exec(entry.name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readOptionalStable(path: string, maxBytes: number): Promise<Buffer | null> {
  try {
    return await readStable(path, maxBytes);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readStable(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('dot_legacy_source_invalid');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error('dot_legacy_source_changed');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
