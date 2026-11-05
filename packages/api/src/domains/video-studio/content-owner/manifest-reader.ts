import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ProjectContentStateV1, validateProjectContentState } from './state/manifest.js';

const MANIFEST_READ_WINDOW = 4;

/** Fresh, complete canonical walk. Each bounded batch settles before yielding or rejecting. */
export async function* readOwnerManifests(rootDir: string): AsyncGenerator<ProjectContentStateV1> {
  const directory = await openOwnerManifestDirectory(rootDir);
  if (!directory) return;
  let batch: Dirent[] = [];
  for await (const entry of directory) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    batch.push(entry);
    if (batch.length === MANIFEST_READ_WINDOW) {
      yield* readManifestBatch(rootDir, batch);
      batch = [];
    }
  }
  yield* readManifestBatch(rootDir, batch);
}

async function* readManifestBatch(rootDir: string, entries: readonly Dirent[]): AsyncGenerator<ProjectContentStateV1> {
  const results = await Promise.allSettled(entries.map((entry) => readOwnerManifest(rootDir, entry)));
  // Preserve directory order and its first error; no in-flight read escapes early return or failure.
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    yield result.value;
  }
}

async function openOwnerManifestDirectory(rootDir: string) {
  try {
    return await opendir(rootDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readOwnerManifest(rootDir: string, entry: Dirent): Promise<ProjectContentStateV1> {
  let raw: string;
  try {
    raw = await readFile(join(rootDir, entry.name, 'state.json'), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error(`Incomplete content owner manifest: ${entry.name}`, { cause: error });
    throw error;
  }
  const identity: unknown = JSON.parse(raw);
  if (
    typeof identity !== 'object' ||
    identity === null ||
    Array.isArray(identity) ||
    !('contentRef' in identity) ||
    typeof identity.contentRef !== 'string' ||
    contentKey(identity.contentRef) !== entry.name
  )
    throw new Error('Invalid content owner manifest identity');
  return validateProjectContentState(identity, identity.contentRef);
}

export function contentKey(contentRef: string): string {
  return createHash('sha256').update(contentRef).digest('hex');
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
