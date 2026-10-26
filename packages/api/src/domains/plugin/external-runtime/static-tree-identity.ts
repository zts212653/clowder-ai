import type { BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SealReadDiagnostics } from '../diagnostics/observation-work.js';
import { StaticMetadataQueue } from './static-metadata-queue.js';

type TreeIdentity = ReadonlyMap<string, string>;

function identity(stat: BigIntStats): string {
  // Reads may change atime. Every original mutation/identity field stays in the
  // proof, including ctime, which utimes cannot restore, and inode/device.
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(':');
}

/** Each consumer still reads a complete fresh tree; no result or time cache. */
export class StaticTreeIdentity {
  private readonly io = new StaticMetadataQueue();
  constructor(private readonly onFailure: () => void) {}

  async snapshot(root: string, diagnostics?: SealReadDiagnostics): Promise<TreeIdentity> {
    const scan = this.io.begin(diagnostics?.caller);
    const entries = new Map<string, string>();
    const inspect = async (path: string): Promise<void> => {
      const before = await this.io.run(scan, 'lstat', () => lstat(path, { bigint: true }));
      if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()))
        throw new Error('static package contains a link or special entry');
      if (path === root && !before.isDirectory()) throw new Error('static package root changed');
      entries.set(path, identity(before));
      if (before.isDirectory()) {
        const names = await this.io.run(scan, 'readdir', () => readdir(path));
        const children = await Promise.allSettled(names.sort().map((name) => walk(resolve(path, name))));
        const failed = children.find((child) => child.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        // Every descendant completes before its parent's final identity check.
        // Drain siblings even on failure before a caller releases this tree.
        if (identity(await this.io.run(scan, 'lstat', () => lstat(path, { bigint: true }))) !== identity(before))
          throw new Error('static package changed during verification');
      }
    };
    const walk = async (path: string): Promise<void> => {
      try {
        await inspect(path);
      } catch (error) {
        // Revoke the generation as soon as one reader fails, while ancestors
        // still drain siblings; another consumer must not pass in that interval.
        this.onFailure();
        throw error;
      }
    };
    try {
      await walk(root);
      return entries;
    } finally {
      this.io.finish(scan, diagnostics);
    }
  }
}
