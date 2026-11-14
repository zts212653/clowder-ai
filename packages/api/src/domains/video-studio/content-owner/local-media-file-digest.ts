import { type BigIntStats, constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { digestWorkspaceFile } from '../../workspace/workspace-content-source-utils.js';
import { MAX_STREAM_CONTENT_BYTES } from './stream-content.js';

function identity(path: string, info: BigIntStats) {
  return [path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Bounded streaming hashes; a cache hit never substitutes for inode/path and mode checks. */
export class LocalMediaFileDigest {
  private readonly digests = new Map<string, string>();

  async matches(path: string, expected: string, readOnly = false): Promise<boolean> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!file) return false;
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size <= 0n ||
        before.size > BigInt(MAX_STREAM_CONTENT_BYTES) ||
        (readOnly && (before.mode & 0o222n) !== 0n)
      )
        return false;
      const canonical = await realpath(path);
      const key = identity(canonical, before);
      let digest = this.digests.get(key);
      if (!digest) {
        const measured = await digestWorkspaceFile(file, Number(before.size), false);
        if (measured.byteLength !== Number(before.size)) return false;
        digest = measured.digest;
      }
      const [after, named] = await Promise.all([file.stat({ bigint: true }), stat(path, { bigint: true })]);
      if (identity(canonical, after) !== key || identity(await realpath(path), named) !== key) return false;
      const oldest = this.digests.keys().next().value;
      if (this.digests.size >= 64 && oldest) this.digests.delete(oldest);
      this.digests.set(key, digest);
      return digest === expected;
    } catch {
      return false;
    } finally {
      await file.close();
    }
  }
}
