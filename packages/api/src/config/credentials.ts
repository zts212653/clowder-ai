/**
 * clowder-ai#340 — Credential keychain
 *
 * Pure read/write layer for {projectRoot}/.cat-cafe/credentials.json.
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env → uses that root instead.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CredentialEntry } from '@cat-cafe/shared';
import { assertSafeTestConfigRoot } from './test-config-write-guard.js';

const CONFIG_SUBDIR = '.cat-cafe';
const CREDENTIALS_FILENAME = 'credentials.json';

function resolveGlobalRoot(projectRoot?: string): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return resolve(envRoot);
  if (projectRoot) return resolve(projectRoot);
  return homedir();
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
  const credPath = resolveCredentialsPath(projectRoot);
  if (!existsSync(credPath)) return {};
  try {
    const raw = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, CredentialEntry>;
  } catch {
    return {};
  }
}

export function assertCredentialsReadable(projectRoot?: string): void {
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
  return readAll(projectRoot)[ref];
}

export function writeCredential(ref: string, entry: CredentialEntry, projectRoot?: string): void {
  assertSafeTestConfigRoot(resolveGlobalRoot(projectRoot), 'credentials.writeCredential');
  const creds = readAll(projectRoot);
  creds[ref] = entry;
  writeAll(creds, projectRoot);
}

export function deleteCredential(ref: string, projectRoot?: string): void {
  assertSafeTestConfigRoot(resolveGlobalRoot(projectRoot), 'credentials.deleteCredential');
  const creds = readAll(projectRoot);
  if (!(ref in creds)) return;
  delete creds[ref];
  writeAll(creds, projectRoot);
}

export function hasCredential(ref: string, projectRoot?: string): boolean {
  return ref in readAll(projectRoot);
}
