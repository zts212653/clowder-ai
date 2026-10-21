import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  findOwnedUnixProcesses,
  readCliProcessOwnerRecords,
  sameUnixProcess,
  type UnixProcessIdentity,
  type UnixProcessSnapshotEntry,
} from '../../../../../../../utils/cli-process-ownership.js';
import { AGY_NATIVE_CREDENTIAL_DIR } from '../agy-native-credential-file.js';
import { AGY_NATIVE_RUNS } from '../agy-native-run-profile.js';

export interface ProfileTurnOwner {
  readonly identity: UnixProcessIdentity;
  readonly dataRoot: string;
  readonly invocationId?: string;
  readonly runHome?: string;
  readonly preparation?: boolean;
}

export interface AgyNativeTurnScope {
  readonly conversationId?: string;
  readonly runHome?: string;
  readonly preparation?: boolean;
}

export class AgyNativeProfileBusyError extends Error {}

export function isNativeTurnRetiredFromSnapshot(
  owner: ProfileTurnOwner,
  home: string,
  snapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>,
): boolean {
  if (sameUnixProcess(owner.identity, snapshot.get(owner.identity.pid))) return false;
  // The API may have died while its supervised provider tree is still draining.
  const records = readCliProcessOwnerRecords(owner.dataRoot);
  if (records.invalidPaths.length) return false;
  if (
    records.records.some(
      ({ manifest }) =>
        Boolean(owner.invocationId) &&
        manifest.execution?.invocationId === owner.invocationId &&
        findOwnedUnixProcesses(snapshot, manifest.ownerId).length > 0,
    )
  )
    return false;
  const marker = owner.runHome ? `--gemini_dir=${join(owner.runHome, '.gemini')}` : `HOME=${home}`;
  return ![...snapshot.values()].some((entry) => {
    const environment = entry.commandAndEnvironment ?? '';
    if (
      owner.preparation &&
      !/\/security (?:create-keychain|unlock-keychain|set-keychain-settings|default-keychain|list-keychains)\b/.test(
        environment,
      )
    )
      return false;
    const start = environment.indexOf(marker);
    return (
      start >= 0 &&
      (start === 0 || /\s/.test(environment[start - 1] ?? '')) &&
      (start + marker.length === environment.length || /\s/.test(environment[start + marker.length] ?? ''))
    );
  });
}

export function retireOrphanCredentials(home: string, accountHome: string): void {
  // Validate ancestors too: a run-home symlink must never redirect orphan cleanup
  // into another live invocation's configuration.
  for (const path of [
    ...(home !== accountHome ? [join(accountHome, AGY_NATIVE_RUNS), home] : [home]),
    join(home, '.gemini'),
    join(home, '.gemini/config'),
  ]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native orphan credential ancestor is unsafe');
  }
  const directory = join(home, '.gemini/config', AGY_NATIVE_CREDENTIAL_DIR);
  let files: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native credential directory is unsafe');
    files = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of files) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native orphan credential is not a regular host file');
    rmSync(path);
  }
}

export function parseNativeTurnOwner(raw: string, home: string): ProfileTurnOwner {
  const owner = JSON.parse(raw) as ProfileTurnOwner;
  if (!owner.identity?.startedAt || !Number.isSafeInteger(owner.identity.pid) || !owner.dataRoot)
    throw new Error('Native profile lease has invalid ownership evidence');
  if (
    owner.runHome &&
    (dirname(owner.runHome) !== join(home, AGY_NATIVE_RUNS) || !/^run-[A-Za-z0-9]+$/.test(basename(owner.runHome)))
  )
    throw new Error('Native conversation lease has an invalid run directory');
  return owner;
}

export function openNativeTurnStore(
  home: string,
  scope: AgyNativeTurnScope,
  timeout = 5000,
): {
  db: Database.Database;
  table: 'native_conversation_turn' | 'native_profile_turn';
  key: 'conversation_id' | 'slot';
  value: string | number;
} {
  const path = join(home, '.cat-cafe-native-turn.sqlite');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile()))
    throw new Error('Native profile lease is not a regular host file');
  const db = new Database(path, { timeout });
  const conversation = scope.conversationId;
  const table = conversation ? 'native_conversation_turn' : 'native_profile_turn';
  const key = conversation ? 'conversation_id' : 'slot';
  const value = conversation ?? 1;
  try {
    db.exec(
      conversation
        ? 'CREATE TABLE IF NOT EXISTS native_conversation_turn (conversation_id TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT NOT NULL)'
        : 'CREATE TABLE IF NOT EXISTS native_profile_turn (slot INTEGER PRIMARY KEY CHECK(slot = 1), token TEXT NOT NULL, owner TEXT NOT NULL)',
    );
    return { db, table, key, value };
  } catch (error) {
    db.close();
    throw error;
  }
}
