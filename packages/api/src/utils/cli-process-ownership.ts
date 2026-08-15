import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { debuglog } from 'node:util';

export const CLI_PROCESS_OWNER_ENV = 'CAT_CAFE_PROCESS_OWNER_ID';
export const CLI_PROCESS_SNAPSHOT_TIMEOUT_MS = 2_000;
export const CLI_SUPERVISOR_SOCKET_DIR_ENV = 'CAT_CAFE_SUPERVISOR_SOCKET_DIR';
const OWNER_DIRECTORY = 'cli-process-owners';
const SOCKET_DIRECTORY_PREFIX = 'cat-cafe-codex-host-';
const OWNER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const processDebug = debuglog('cat-cafe-cli-supervisor');

export interface UnixProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
}

export interface UnixProcessSnapshotEntry extends UnixProcessIdentity {
  commandAndEnvironment?: string;
}

export interface CliProcessOwnerManifest {
  v: 1;
  ownerId: string;
  createdAt: number;
  supervisor: UnixProcessIdentity;
  root?: UnixProcessIdentity;
  socketDirectory?: string;
}

export interface CliProcessOwnerRecord {
  path: string;
  manifest: CliProcessOwnerManifest;
}

export interface CliProcessOwnerHandle extends CliProcessOwnerRecord {
  directory: string;
}

export interface ReadOwnerRecordsResult {
  records: CliProcessOwnerRecord[];
  invalidPaths: string[];
}

interface ProcessSnapshotOptions {
  includeEnvironment?: boolean;
  pids?: readonly number[];
}

export function buildUnixProcessSnapshotArgs(
  includeEnvironment: boolean,
  pids: readonly number[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const selection = pids ? ['-p', pids.join(',')] : ['-ax'];
  if (!includeEnvironment) {
    return [...selection, '-o', 'pid=,ppid=,pgid=,lstart=,command='];
  }

  // Linux ownership discovery reads /proc/<pid>/environ after this identity
  // snapshot. procps 4.0.4 accepts `environ` as a format name but renders it
  // as an empty placeholder, so requesting that field would silently discard
  // the inherited owner token on current GitHub Ubuntu runners.
  if (platform === 'linux') {
    return ['-ww', ...selection, '-o', 'pid=,ppid=,pgid=,lstart='];
  }
  return ['eww', ...selection, '-o', 'pid=,ppid=,pgid=,lstart=,command='];
}

export function decodeLinuxProcEnvironment(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8').replaceAll('\0', ' ');
}

function readLinuxProcEnvironmentSync(pid: number): string | undefined {
  try {
    return decodeLinuxProcEnvironment(readFileSync(`/proc/${pid}/environ`));
  } catch {
    // Processes can exit between the process-table snapshot and the procfs
    // read, and kernel ptrace policy can hide processes owned by another user.
    return undefined;
  }
}

function attachLinuxProcEnvironment(entry: UnixProcessSnapshotEntry, includeEnvironment: boolean): void {
  if (!includeEnvironment || process.platform !== 'linux') return;
  const environment = readLinuxProcEnvironmentSync(entry.pid);
  if (environment === undefined) delete entry.commandAndEnvironment;
  else entry.commandAndEnvironment = environment;
}

function parseSnapshotLine(line: string, includeEnvironment: boolean): UnixProcessSnapshotEntry | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) return null;
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  const pgid = Number(parts[2]);
  if (!isPositiveSafeInteger(pid) || !isPositiveSafeInteger(ppid) || !isPositiveSafeInteger(pgid)) return null;
  return {
    pid,
    ppid,
    pgid,
    startedAt: parts.slice(3, 8).join(' '),
    ...(includeEnvironment ? { commandAndEnvironment: parts.slice(8).join(' ') } : {}),
  };
}

function expandHome(raw: string, homeDir: string): string {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return join(homeDir, raw.slice(2));
  return raw;
}

export function resolveCatCafeDataRoot(dataDir = process.env.CAT_CAFE_DATA_DIR, homeDir = homedir()): string {
  const raw = dataDir?.trim();
  return raw ? resolve(expandHome(raw, homeDir)) : join(homeDir, '.cat-cafe');
}

export function resolveCliProcessOwnerDirectory(dataDir = process.env.CAT_CAFE_DATA_DIR, homeDir = homedir()): string {
  return join(resolveCatCafeDataRoot(dataDir, homeDir), OWNER_DIRECTORY);
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

export function isValidatedCodexSocketDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const resolved = resolve(path);
  let realTemporaryRoot: string;
  let realParent: string;
  try {
    realTemporaryRoot = realpathSync('/tmp');
    realParent = realpathSync(dirname(resolved));
  } catch {
    return false;
  }
  const name = basename(resolved);
  return realParent === realTemporaryRoot && name.startsWith(SOCKET_DIRECTORY_PREFIX) && name.length > 24;
}

export function parseCliProcessOwnerManifest(value: unknown): CliProcessOwnerManifest | null {
  const record = asRecord(value);
  if (!record || record.v !== 1 || typeof record.ownerId !== 'string' || !OWNER_ID_RE.test(record.ownerId)) {
    return null;
  }
  if (!isPositiveSafeInteger(record.createdAt)) return null;
  const supervisor = parseProcessIdentity(record.supervisor);
  if (!supervisor) return null;
  const root = record.root === undefined ? undefined : parseProcessIdentity(record.root);
  if (record.root !== undefined && !root) return null;
  const socketDirectory = record.socketDirectory;
  if (socketDirectory !== undefined) {
    if (typeof socketDirectory !== 'string' || !isValidatedCodexSocketDirectory(socketDirectory)) return null;
  }
  return {
    v: 1,
    ownerId: record.ownerId,
    createdAt: record.createdAt,
    supervisor,
    ...(root ? { root } : {}),
    ...(typeof socketDirectory === 'string' ? { socketDirectory: resolve(socketDirectory) } : {}),
  };
}

function atomicWriteManifest(path: string, manifest: CliProcessOwnerManifest): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function readUnixProcessSnapshotSync(
  options: ProcessSnapshotOptions = {},
): Map<number, UnixProcessSnapshotEntry> | null {
  if (process.platform === 'win32') return null;
  const pids = options.pids?.filter(isPositiveSafeInteger);
  if (pids && pids.length === 0) return new Map();
  const args = buildUnixProcessSnapshotArgs(options.includeEnvironment === true, pids);
  if (options.includeEnvironment) processDebug('ownership-process-table-scan');
  const result = spawnSync('/bin/ps', args, {
    encoding: 'utf8',
    timeout: CLI_PROCESS_SNAPSHOT_TIMEOUT_MS,
    maxBuffer: options.includeEnvironment ? 32 * 1024 * 1024 : 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;

  const snapshot = new Map<number, UnixProcessSnapshotEntry>();
  for (const line of result.stdout.split('\n')) {
    const entry = parseSnapshotLine(line, options.includeEnvironment === true);
    if (!entry) continue;
    attachLinuxProcEnvironment(entry, options.includeEnvironment === true);
    snapshot.set(entry.pid, entry);
  }
  return snapshot;
}

export function sameUnixProcess(expected: UnixProcessIdentity, actual: UnixProcessIdentity | undefined): boolean {
  return actual?.startedAt === expected.startedAt;
}

function containsOwnerToken(text: string | undefined, ownerId: string): boolean {
  if (!text) return false;
  const marker = `${CLI_PROCESS_OWNER_ENV}=${ownerId}`;
  const index = text.indexOf(marker);
  if (index < 0) return false;
  const before = index === 0 ? ' ' : text[index - 1];
  const afterIndex = index + marker.length;
  const after = afterIndex === text.length ? ' ' : text[afterIndex];
  return /\s/.test(before) && /\s/.test(after);
}

export function findOwnedUnixProcesses(
  snapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>,
  ownerId: string,
): UnixProcessIdentity[] {
  if (!OWNER_ID_RE.test(ownerId)) return [];
  return [...snapshot.values()].filter((entry) => containsOwnerToken(entry.commandAndEnvironment, ownerId));
}

function groupProcessIds(snapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (const entry of snapshot.values()) {
    const members = groups.get(entry.pgid) ?? [];
    members.push(entry.pid);
    groups.set(entry.pgid, members);
  }
  return groups;
}

function trySignal(kill: (pid: number, signal: NodeJS.Signals) => void, pid: number, signal: NodeJS.Signals): boolean {
  try {
    kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalSafeOwnedGroups(
  targets: readonly UnixProcessIdentity[],
  groupMembers: ReadonlyMap<number, readonly number[]>,
  ownedPids: ReadonlySet<number>,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void,
): Set<number> {
  const signaled = new Set<number>();
  for (const target of targets) {
    if (target.pid !== target.pgid) continue;
    const members = groupMembers.get(target.pgid) ?? [];
    if (members.length === 0 || members.some((pid) => !ownedPids.has(pid))) continue;
    if (trySignal(kill, -target.pgid, signal)) for (const pid of members) signaled.add(pid);
  }
  return signaled;
}

export function signalOwnedUnixProcesses(
  targets: readonly UnixProcessIdentity[],
  snapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): number {
  const ownedPids = new Set(targets.map((target) => target.pid));
  const groupMembers = groupProcessIds(snapshot);
  const signaled = signalSafeOwnedGroups(targets, groupMembers, ownedPids, signal, kill);
  for (const target of targets) {
    if (signaled.has(target.pid)) continue;
    if (trySignal(kill, target.pid, signal)) signaled.add(target.pid);
  }
  return signaled.size;
}

export function createCliProcessOwnerManifest(options: {
  dataDir?: string;
  socketDirectory?: string;
}): CliProcessOwnerHandle {
  const supervisor = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
  if (!supervisor) throw new Error('cannot capture supervisor process identity');
  if (options.socketDirectory && !isValidatedCodexSocketDirectory(options.socketDirectory)) {
    throw new Error('invalid Codex socket directory ownership path');
  }
  const directory = resolveCliProcessOwnerDirectory(options.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const ownerId = randomUUID();
  const manifest: CliProcessOwnerManifest = {
    v: 1,
    ownerId,
    createdAt: Date.now(),
    supervisor,
    ...(options.socketDirectory ? { socketDirectory: resolve(options.socketDirectory) } : {}),
  };
  const path = join(directory, `${ownerId}.json`);
  atomicWriteManifest(path, manifest);
  return { directory, path, manifest };
}

export function recordCliProcessOwnerRoot(handle: CliProcessOwnerHandle, pid: number): void {
  const root = readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid);
  if (!root) return;
  handle.manifest = { ...handle.manifest, root };
  atomicWriteManifest(handle.path, handle.manifest);
}

export function readCliProcessOwnerRecords(dataDir?: string): ReadOwnerRecordsResult {
  const directory = resolveCliProcessOwnerDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalidPaths: [] };
    throw error;
  }
  const records: CliProcessOwnerRecord[] = [];
  const invalidPaths: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const manifest = parseCliProcessOwnerManifest(JSON.parse(readFileSync(path, 'utf8')));
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

export function completeCliProcessOwnerCleanup(record: CliProcessOwnerRecord): void {
  if (record.manifest.socketDirectory) {
    if (!isValidatedCodexSocketDirectory(record.manifest.socketDirectory)) {
      throw new Error('refusing unsafe socket directory cleanup');
    }
    rmSync(record.manifest.socketDirectory, { recursive: true, force: true });
  }
  try {
    unlinkSync(record.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
