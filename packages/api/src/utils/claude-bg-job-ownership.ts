import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  readUnixProcessSnapshotSync,
  resolveCatCafeDataRoot,
  type UnixProcessIdentity,
} from './cli-process-ownership.js';

const OWNER_DIRECTORY = 'claude-bg-job-owners';
const OWNER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[a-f0-9]{8}$/;
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const PROCESS_OWNER_ENV = 'CAT_CAFE_PROCESS_OWNER_ID';

export interface ClaudeBgJobStopContext {
  claudeConfigDir?: string;
}

interface ClaudeBgJobOwnerBase {
  v: 2;
  ownerId: string;
  createdAt: number;
  apiOwner: UnixProcessIdentity;
  stopContext: ClaudeBgJobStopContext;
}

export type ClaudeBgJobOwnerManifest =
  | (ClaudeBgJobOwnerBase & { state: 'pending' })
  | (ClaudeBgJobOwnerBase & { state: 'active'; shortId: string });

export interface ClaudeBgJobOwnerRecord {
  path: string;
  manifest: ClaudeBgJobOwnerManifest;
}

export interface ClaudeBgJobOwnerHandle extends ClaudeBgJobOwnerRecord {
  directory: string;
}

export interface ReadClaudeBgJobOwnerRecordsResult {
  records: ClaudeBgJobOwnerRecord[];
  invalidPaths: string[];
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProcessIdentity(value: unknown): UnixProcessIdentity | null {
  const record = asRecord(value);
  if (!record) return null;
  if (!isPositiveSafeInteger(record.pid) || !isPositiveSafeInteger(record.ppid)) return null;
  if (!isPositiveSafeInteger(record.pgid) || typeof record.startedAt !== 'string' || !record.startedAt.trim()) {
    return null;
  }
  return {
    pid: record.pid,
    ppid: record.ppid,
    pgid: record.pgid,
    startedAt: record.startedAt.trim(),
  };
}

export function resolveClaudeBgJobOwnerDirectory(dataDir?: string): string {
  return join(resolveCatCafeDataRoot(dataDir), OWNER_DIRECTORY);
}

function parseClaudeBgJobStopContext(value: unknown): ClaudeBgJobStopContext | null {
  const record = asRecord(value);
  if (!record) return null;
  if (Object.keys(record).some((key) => key !== 'claudeConfigDir')) return null;
  if (record.claudeConfigDir === undefined) return {};
  if (
    typeof record.claudeConfigDir !== 'string' ||
    !record.claudeConfigDir ||
    record.claudeConfigDir.includes('\0') ||
    !isAbsolute(record.claudeConfigDir)
  ) {
    return null;
  }
  return { claudeConfigDir: resolve(record.claudeConfigDir) };
}

/**
 * Capture the provider-native namespace required to address a Claude Agent
 * View job after API restart. The allowlist is intentionally one path-only
 * key: credentials and arbitrary account env must never enter the manifest.
 */
export function captureClaudeBgJobStopContext(env: NodeJS.ProcessEnv, cwd: string): ClaudeBgJobStopContext {
  const raw = env[CLAUDE_CONFIG_DIR_ENV];
  if (raw === undefined || raw.trim().length === 0) return {};
  if (raw.includes('\0')) throw new Error('invalid CLAUDE_CONFIG_DIR for Claude bg recovery');
  return { claudeConfigDir: isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw) };
}

/** Build a stop dispatcher env from a validated durable namespace. */
export function buildClaudeBgJobStopEnv(
  baseEnv: NodeJS.ProcessEnv,
  context: ClaudeBgJobStopContext,
): NodeJS.ProcessEnv {
  const validated = parseClaudeBgJobStopContext(context);
  if (!validated) throw new Error('invalid Claude bg stop context');
  const env = { ...baseEnv };
  delete env[PROCESS_OWNER_ENV];
  if (validated.claudeConfigDir) env[CLAUDE_CONFIG_DIR_ENV] = validated.claudeConfigDir;
  else delete env[CLAUDE_CONFIG_DIR_ENV];
  return env;
}

export function parseClaudeBgJobOwnerManifest(value: unknown): ClaudeBgJobOwnerManifest | null {
  const record = asRecord(value);
  if (!record || record.v !== 2 || typeof record.ownerId !== 'string' || !OWNER_ID_RE.test(record.ownerId)) {
    return null;
  }
  if (!isPositiveSafeInteger(record.createdAt)) return null;
  const apiOwner = parseProcessIdentity(record.apiOwner);
  if (!apiOwner) return null;
  const stopContext = parseClaudeBgJobStopContext(record.stopContext);
  if (!stopContext) return null;
  if (record.state === 'pending' && record.shortId === undefined) {
    return { v: 2, ownerId: record.ownerId, createdAt: record.createdAt, apiOwner, stopContext, state: 'pending' };
  }
  if (record.state === 'active' && typeof record.shortId === 'string' && SHORT_ID_RE.test(record.shortId)) {
    return {
      v: 2,
      ownerId: record.ownerId,
      createdAt: record.createdAt,
      apiOwner,
      stopContext,
      state: 'active',
      shortId: record.shortId,
    };
  }
  return null;
}

function atomicWriteManifest(path: string, manifest: ClaudeBgJobOwnerManifest): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function createClaudeBgJobOwnerManifest(
  dataDir?: string,
  stopContext: ClaudeBgJobStopContext = {},
): ClaudeBgJobOwnerHandle {
  const apiOwner = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
  if (!apiOwner) throw new Error('cannot capture Claude bg API owner process identity');
  const validatedStopContext = parseClaudeBgJobStopContext(stopContext);
  if (!validatedStopContext) throw new Error('invalid Claude bg stop context');
  const directory = resolveClaudeBgJobOwnerDirectory(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const ownerId = randomUUID();
  const manifest: ClaudeBgJobOwnerManifest = {
    v: 2,
    ownerId,
    createdAt: Date.now(),
    apiOwner,
    stopContext: validatedStopContext,
    state: 'pending',
  };
  const path = join(directory, `${ownerId}.json`);
  atomicWriteManifest(path, manifest);
  return { directory, path, manifest };
}

export function activateClaudeBgJobOwner(handle: ClaudeBgJobOwnerHandle, shortId: string): void {
  if (!SHORT_ID_RE.test(shortId)) throw new Error('invalid Claude bg short id');
  handle.manifest = { ...handle.manifest, state: 'active', shortId };
  atomicWriteManifest(handle.path, handle.manifest);
}

export function readClaudeBgJobOwnerRecords(dataDir?: string): ReadClaudeBgJobOwnerRecordsResult {
  const directory = resolveClaudeBgJobOwnerDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalidPaths: [] };
    throw error;
  }
  const records: ClaudeBgJobOwnerRecord[] = [];
  const invalidPaths: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const manifest = parseClaudeBgJobOwnerManifest(JSON.parse(readFileSync(path, 'utf8')));
      if (!manifest || name !== `${manifest.ownerId}.json`) {
        invalidPaths.push(path);
        continue;
      }
      records.push({ path, manifest });
    } catch {
      invalidPaths.push(path);
    }
  }
  return { records, invalidPaths };
}

export function completeClaudeBgJobOwner(record: ClaudeBgJobOwnerRecord): void {
  try {
    unlinkSync(record.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
