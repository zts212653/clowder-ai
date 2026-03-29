/**
 * F136 Phase 4a — Credential keychain (HC-1: object structure, global scope)
 *
 * Pure read/write layer for ~/.cat-cafe/credentials.json.
 * No metadata, no business logic — just a keychain.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { CredentialEntry } from '@cat-cafe/shared';

const CAT_CAFE_DIR = '.cat-cafe';
const CREDENTIALS_FILENAME = 'credentials.json';

function resolveGlobalRoot(): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return resolve(envRoot);
  return homedir();
}

export function resolveCredentialsPath(): string {
  return resolve(resolveGlobalRoot(), CAT_CAFE_DIR, CREDENTIALS_FILENAME);
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

function readAll(): Record<string, CredentialEntry> {
  const credPath = resolveCredentialsPath();
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

function writeAll(creds: Record<string, CredentialEntry>): void {
  const credPath = resolveCredentialsPath();
  mkdirSync(resolve(resolveGlobalRoot(), CAT_CAFE_DIR), { recursive: true });
  writeFileAtomic(credPath, `${JSON.stringify(creds, null, 2)}\n`);
  chmodSync(credPath, 0o600);
}

export function readCredentials(): Record<string, CredentialEntry> {
  return readAll();
}

export function readCredential(ref: string): CredentialEntry | undefined {
  return readAll()[ref];
}

export function writeCredential(ref: string, entry: CredentialEntry): void {
  const creds = readAll();
  creds[ref] = entry;
  writeAll(creds);
}

export function deleteCredential(ref: string): void {
  const creds = readAll();
  if (!(ref in creds)) return;
  delete creds[ref];
  writeAll(creds);
}

export function hasCredential(ref: string): boolean {
  return ref in readAll();
}
