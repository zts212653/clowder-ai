import { randomUUID } from 'node:crypto';
import { type BigIntStats, linkSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  failAfterPreferenceCleanup,
  preferenceCleanupFailures,
  removePreferenceWriteFile,
} from './preference-write-cleanup.js';

export type BackgroundGenerationPin = { readonly id: string };

const generationId = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const pinDirectory = (root: string) => resolve(root, '.cat-cafe', 'user-preferences.generations');
export const userPreferencesPath = (root: string) => resolve(root, '.cat-cafe', 'user-preferences.json');

function generation(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null || !('fileGeneration' in metadata)) return undefined;
  const value = metadata.fileGeneration;
  return typeof value === 'string' && generationId.test(value) ? value : undefined;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// Both names must reference a LIVE regular inode. Keeping the pin linked prevents
// that inode being freed/reused, including on filesystems with no birthtime.
function sameLiveFile(current: BigIntStats, pin: BigIntStats): boolean {
  return (
    current.isFile() &&
    pin.isFile() &&
    current.ino > 0n &&
    pin.ino > 0n &&
    current.nlink >= 2n &&
    pin.nlink >= 2n &&
    current.dev === pin.dev &&
    current.ino === pin.ino
  );
}

export function backgroundMetadataIsCurrent(root: string, metadata: unknown): boolean {
  const id = generation(metadata);
  if (!id) return false;
  try {
    return sameLiveFile(
      lstatSync(userPreferencesPath(root), { bigint: true }),
      lstatSync(join(pinDirectory(root), id), { bigint: true }),
    );
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function pinBackgroundGeneration(root: string, tempPath: string): BackgroundGenerationPin {
  const id = randomUUID();
  mkdirSync(pinDirectory(root), { recursive: true });
  const pinPath = join(pinDirectory(root), id);
  linkSync(tempPath, pinPath);
  try {
    if (!sameLiveFile(lstatSync(tempPath, { bigint: true }), lstatSync(pinPath, { bigint: true }))) {
      throw new Error('Filesystem cannot prove the background preference generation');
    }
    return { id };
  } catch (error) {
    failAfterPreferenceCleanup(error, [
      { label: 'unverified generation pin', run: () => removePreferenceWriteFile(pinPath) },
    ]);
  }
}

export function removeBackgroundGeneration(root: string, id: string): void {
  removePreferenceWriteFile(join(pinDirectory(root), id));
}

/** After publication only: also collect pins left by an interrupted prior write. */
export function collectBackgroundGenerations(root: string, keep: BackgroundGenerationPin | undefined): void {
  let names: string[];
  try {
    names = readdirSync(pinDirectory(root));
  } catch (error) {
    // A committed preference write succeeded even when old-file collection fails.
    if (!missing(error)) console.warn('Background generation collection failed', error);
    return;
  }
  const errors = preferenceCleanupFailures(
    names
      .filter((name) => generationId.test(name) && name !== keep?.id)
      .map((name) => ({ label: `obsolete generation ${name}`, run: () => removeBackgroundGeneration(root, name) })),
  );
  if (errors.length) console.warn('Background generation collection failed', new AggregateError(errors));
}
