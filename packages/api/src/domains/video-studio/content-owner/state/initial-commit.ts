import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContentStream, writeOwnerPayload } from '../stream-content.js';
import type { ProjectContentStateV1 } from './manifest.js';

/** A refused first publication must never leave a half-manifest in the canonical catalogue. */
export async function commitInitialOwnerState(input: {
  root: string;
  target: string;
  state: ProjectContentStateV1;
  bytes: Uint8Array | ContentStream;
  authorizeEffect: () => Promise<void>;
}) {
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const staged = await mkdtemp(join(input.root, '.prepared-import-'));
  try {
    await mkdir(join(staged, 'blobs'), { mode: 0o700 });
    const digest = input.state.revisions[0]?.blobDigest;
    if (!digest || input.state.currentOwnerRevision !== 1) throw new Error('Initial owner commit requires one version');
    await durableFile(join(staged, 'blobs', digest.slice('sha256:'.length)), input.bytes);
    await durableFile(join(staged, 'state.json'), Buffer.from(`${JSON.stringify(input.state, null, 2)}\n`));
    await input.authorizeEffect();
    await rename(staged, input.target);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

async function durableFile(path: string, bytes: Uint8Array | ContentStream) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await writeOwnerPayload(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
