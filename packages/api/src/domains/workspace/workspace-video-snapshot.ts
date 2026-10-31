import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeImmutableVideoFile } from '../video-studio/content-owner/published-media-probe.js';
import { WorkspaceContentSourceError } from './workspace-content-source-contract.js';

/** F063 owns this request-scoped copy until the returned stream closes. No source file is written. */
export async function freezeWorkspaceVideo(input: {
  handle: FileHandle;
  byteLength: number;
  expectedRevision: string;
  assertSourceCurrent: () => Promise<void>;
}) {
  const snapshot = await freezeWorkspaceFile(input);
  try {
    const media = await probeImmutableVideoFile(snapshot.path).catch(() => {
      throw new WorkspaceContentSourceError('unsupported_media');
    });
    const frozen = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = frozen.createReadStream({ highWaterMark: 256 * 1024 });
    stream.once('close', () => {
      void snapshot.cleanup().catch(() => undefined);
    });
    return { byteLength: snapshot.byteLength, revision: snapshot.revision, media, stream };
  } catch (error) {
    await snapshot.cleanup();
    throw error;
  }
}

/** Also used by Phase A's read-only asset index: raw audio and subtitle bytes need no video decoder. */
export async function freezeWorkspaceFile(input: {
  handle: FileHandle;
  byteLength: number;
  expectedRevision: string;
  assertSourceCurrent: () => Promise<void>;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-workspace-video-'));
  const path = join(directory, 'snapshot.mp4');
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const target = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteLength = 0;
    const chunk = Buffer.allocUnsafe(256 * 1024);
    try {
      while (byteLength < input.byteLength) {
        const length = Math.min(chunk.length, input.byteLength - byteLength);
        const { bytesRead } = await input.handle.read(chunk, 0, length, byteLength);
        if (bytesRead === 0) throw new WorkspaceContentSourceError('revision_changed');
        const bytes = chunk.subarray(0, bytesRead);
        hash.update(bytes);
        await target.writeFile(bytes);
        byteLength += bytesRead;
      }
      await target.sync();
    } finally {
      await target.close();
    }
    const revision = `sha256:${hash.digest('hex')}` as const;
    await input.assertSourceCurrent();
    if (revision !== input.expectedRevision) throw new WorkspaceContentSourceError('revision_changed');
    return { byteLength, revision, path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
