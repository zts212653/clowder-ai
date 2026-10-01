import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateFile, writeAtomicPrivate, writeExclusivePrivate } from '@cat-cafe/shared/node-private-fs';
import { CollectiveServiceError } from './errors.js';
import { digestSecret, secretMatches } from './persistence.js';
import type { ServiceState } from './state.js';

export const BOOTSTRAP_LINK_FILE = 'owner-bootstrap.url';
const PENDING_LINK_PREFIX = `${BOOTSTRAP_LINK_FILE}.pending.`;

export async function validateStartupBootstrap(
  state: ServiceState,
  options: { dataDirectory: string; publicUrl: string },
): Promise<void> {
  if (state.bootstrap.consumedAt !== undefined) return;
  const path = join(options.dataDirectory, BOOTSTRAP_LINK_FILE);
  let link = await readOptionalPrivateFile(path);
  if (link === undefined) {
    // Complete only delivery of a credential whose digest is already committed.
    // Existing malformed/mismatched formal links and old orphan states are never repaired.
    const pendingPath = pendingBootstrapPath(options.dataDirectory, state.bootstrap.tokenDigest);
    const pending = await readOptionalPrivateFile(pendingPath);
    if (pending !== undefined && matchesBootstrapLink(pending, state, options.publicUrl)) {
      await writeExclusivePrivate(path, pending);
      link = await readOptionalPrivateFile(path);
      if (link && matchesBootstrapLink(link, state, options.publicUrl)) await discardPendingBootstrapLink(pendingPath);
    }
    // Another opener may have delivered and removed the matching pending file.
    if (link === undefined) link = await readOptionalPrivateFile(path);
  }
  if (link && matchesBootstrapLink(link, state, options.publicUrl)) return;
  throw new CollectiveServiceError(
    'BOOTSTRAP_UNRECOVERABLE',
    'Collective Service bootstrap_unrecoverable: initialization link is missing or invalid; this version does not support automatic recovery; data is preserved; see #1563',
    409,
  );
}

export async function stageBootstrapLink(directory: string, publicUrl: string, secret: string): Promise<string> {
  const url = new URL(publicUrl);
  url.hash = `bootstrap=${encodeURIComponent(secret)}`;
  const path = pendingBootstrapPath(directory, digestSecret(secret));
  await writeAtomicPrivate(path, `${url.href}\n`);
  return path;
}

function pendingBootstrapPath(directory: string, tokenDigest: string): string {
  // Digest-derived lookup avoids scanning unrelated attempts. Hash the locator
  // too, so even a malformed persisted digest cannot become a path component.
  return join(directory, `${PENDING_LINK_PREFIX}${digestSecret(tokenDigest)}`);
}

export async function discardPendingBootstrapLink(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  await unlink(path).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
  });
}

async function readOptionalPrivateFile(path: string): Promise<string | undefined> {
  try {
    return await readPrivateFile(path);
  } catch (error) {
    // Permission and IO failures are never treated as a lost secret.
    if (!isMissingFile(error)) throw error;
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function matchesBootstrapLink(link: string, state: ServiceState, publicUrl: string): boolean {
  // Startup verifies delivery of the stored credential. Expiry remains enforced
  // when consuming bootstrap or authorizing provider setup, as before.
  try {
    const url = new URL(link.trim());
    const expected = new URL(publicUrl);
    const secret = new URLSearchParams(url.hash.slice(1)).get('bootstrap');
    return (
      url.origin === expected.origin &&
      url.pathname === expected.pathname &&
      !url.search &&
      !url.username &&
      !url.password &&
      Boolean(secret && secretMatches(secret, state.bootstrap.tokenDigest))
    );
  } catch {
    return false;
  }
}
