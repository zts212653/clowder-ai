/**
 * F231: profile data dir (private/profile/) resolver — SINGLE SOURCE OF TRUTH (P4).
 *
 * Shared by the L0 compiler (reads capsule + per-cat primer, injected into the system prompt)
 * and the F231 Phase C profile-update routes (write per-cat primer + provenance). Read and write
 * MUST resolve to the same directory or the nurturing loop silently breaks — a primer written to
 * one path while the injector reads another means operator-approved updates never reach the cat.
 *
 * Read resolution mirrors the original l0-compiler logic: cwd-first when the directory already
 * exists (packaged installs keep user data in the project dir — Windows #802), falling back to the
 * script-relative dir when cwd has no private/profile (e.g. cwd = packages/api during dev/tests).
 *
 * Write resolution must match the read side when there is already profile data: cwd/private/profile
 * wins when present; otherwise an existing script-relative profile dir wins so approvals do not fork
 * from what L0 currently injects. Only first-ever writes with no existing profile dir create
 * cwd/private/profile.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function resolveProfileDir(cwd: string, scriptPath?: string): string {
  const cwdProfileDir = resolve(cwd, 'private', 'profile');
  if (existsSync(cwdProfileDir)) return cwdProfileDir;
  if (scriptPath) return resolve(dirname(scriptPath), '..', 'private', 'profile');
  return cwdProfileDir; // best-effort: no scriptPath to fall back to
}

export function resolveWritableProfileDir(cwd: string, scriptPath?: string): string {
  const cwdProfileDir = resolve(cwd, 'private', 'profile');
  if (existsSync(cwdProfileDir)) return cwdProfileDir;
  if (scriptPath) {
    const readProfileDir = resolve(dirname(scriptPath), '..', 'private', 'profile');
    if (existsSync(readProfileDir)) return readProfileDir;
  }
  return cwdProfileDir;
}
