/**
 * #1203: Shared directory identity primitive for ACP carriers.
 *
 * A pooled ACP child's bootstrap cwd can be deleted by an external cleaner
 * (e.g. a stray test teardown emptying the shared /tmp bootstrap root). The
 * child process stays alive, but any prompt dies with getcwd() ENOENT. Worse,
 * the same path may be recreated later with a different inode; existence alone
 * is not enough to detect the loss.
 *
 * This module captures a directory's identity at spawn time and compares it
 * against the current identity on demand. dev+ino identifies the inode on
 * POSIX; ino is 0 on Windows, where birthtimeMs distinguishes a
 * delete→recreate at the same path.
 */

import { statSync } from 'node:fs';

/** String identity of a directory entry: dev:ino:birthtimeMs. */
export type AcpCwdIdentity = string;

function sampleDirIdentity(path: string): AcpCwdIdentity | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    // Missing dir, or a fake spawn config pointing at a fake path.
    return null;
  }
}

/**
 * Tracks the identity of a directory across its lifetime.
 *
 * - If no identity was captured (e.g. a test injects a fake spawnFn and the
 *   cwd path does not exist), `isIntact` returns true. There is no baseline,
 *   so we cannot prove the cwd was lost.
 * - Transports that genuinely have no local cwd should not use this tracker
 *   as an excuse: `AcpPoolClient.isCwdIntact` is a required contract and such
 *   transports must explicitly return true.
 */
export class AcpCwdIdentityTracker {
  private capturedIdentity: AcpCwdIdentity | null = null;

  constructor(private readonly path: string) {}

  /** Capture the current identity of `path`. Call after mkdir, before spawn. */
  capture(): AcpCwdIdentity | null {
    this.capturedIdentity = sampleDirIdentity(this.path);
    return this.capturedIdentity;
  }

  /** The most recently captured identity, or null if none was captured. */
  get captured(): AcpCwdIdentity | null {
    return this.capturedIdentity;
  }

  /**
   * False when the directory is missing or its identity no longer matches the
   * captured baseline. True when the identity matches, or when no baseline was
   * captured (fake/test path).
   */
  get isIntact(): boolean {
    const current = sampleDirIdentity(this.path);
    if (current === null) return false;
    if (this.capturedIdentity === null) return true;
    return current === this.capturedIdentity;
  }
}
