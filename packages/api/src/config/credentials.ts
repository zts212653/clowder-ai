/**
 * clowder-ai#340 — Credential keychain
 *
 * Pure read/write layer for {projectRoot}/.cat-cafe/credentials.json.
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env → uses that root instead.
 * Topology: resolveAccountWriteRoot (workspace/runtime adjudication).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CredentialEntry } from '@cat-cafe/shared';
import { resolveAccountWriteRoot } from './account-store-topology.js';
import { refStore } from './ref-store.js';
import { assertSafeTestConfigRead, assertSafeTestConfigRoot } from './test-config-write-guard.js';

const CONFIG_SUBDIR = '.cat-cafe';
const CREDENTIALS_FILENAME = 'credentials.json';

function resolveGlobalRoot(projectRoot?: string): string {
  return resolveAccountWriteRoot(projectRoot);
}

export function resolveCredentialsPath(projectRoot?: string): string {
  return resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR, CREDENTIALS_FILENAME);
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

function readAll(projectRoot?: string): Record<string, CredentialEntry> {
  // P1-8: a credential a test can READ is already leaked, whether or not the
  // process goes on to write anything. Guarded before existsSync so the boundary
  // does not depend on the operator's store happening to exist.
  assertSafeTestConfigRead(resolveGlobalRoot(projectRoot), 'credentials.readAll');
  const credPath = resolveCredentialsPath(projectRoot);
  if (!existsSync(credPath)) return refStore<CredentialEntry>();
  try {
    const raw = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refStore<CredentialEntry>();
    return refStore(parsed as Record<string, CredentialEntry>);
  } catch {
    return refStore<CredentialEntry>();
  }
}

export function assertCredentialsReadable(projectRoot?: string): void {
  assertSafeTestConfigRead(resolveGlobalRoot(projectRoot), 'credentials.assertCredentialsReadable');
  const credPath = resolveCredentialsPath(projectRoot);
  if (!existsSync(credPath)) return;

  const raw = readFileSync(credPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid credentials JSON at ${credPath}: expected object`);
  }
}

function writeAll(creds: Record<string, CredentialEntry>, projectRoot?: string): void {
  const credPath = resolveCredentialsPath(projectRoot);
  mkdirSync(resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR), { recursive: true });
  writeFileAtomic(credPath, `${JSON.stringify(creds, null, 2)}\n`);
  chmodSync(credPath, 0o600);
}

export function readCredentials(projectRoot?: string): Record<string, CredentialEntry> {
  return readAll(projectRoot);
}

export function readCredential(ref: string, projectRoot?: string): CredentialEntry | undefined {
  const creds = readAll(projectRoot);
  return Object.hasOwn(creds, ref) ? creds[ref] : undefined;
}

export function writeCredential(ref: string, entry: CredentialEntry, projectRoot?: string): void {
  assertSafeTestConfigRoot(resolveGlobalRoot(projectRoot), 'credentials.writeCredential');
  const creds = readAll(projectRoot);
  // Null-prototype store: plain assignment is safe even for ref === '__proto__'.
  creds[ref] = entry;
  writeAll(creds, projectRoot);
}

export function deleteCredential(ref: string, projectRoot?: string): void {
  assertSafeTestConfigRoot(resolveGlobalRoot(projectRoot), 'credentials.deleteCredential');
  const creds = readAll(projectRoot);
  if (!Object.hasOwn(creds, ref)) return;
  delete creds[ref];
  writeAll(creds, projectRoot);
}

export function hasCredential(ref: string, projectRoot?: string): boolean {
  return Object.hasOwn(readAll(projectRoot), ref);
}
