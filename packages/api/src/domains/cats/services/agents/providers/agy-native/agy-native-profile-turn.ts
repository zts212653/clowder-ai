import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readUnixProcessSnapshotSync,
  resolveCatCafeDataRoot,
  sameUnixProcess,
} from '../../../../../../utils/cli-process-ownership.js';
import { acquireAgyNativeProfileTurnAsync } from './profile-turn/async.js';
import {
  AgyNativeProfileBusyError,
  type AgyNativeTurnScope,
  isNativeTurnRetiredFromSnapshot,
  openNativeTurnStore,
  type ProfileTurnOwner,
  parseNativeTurnOwner,
  retireOrphanCredentials,
} from './profile-turn/store.js';

export { AgyNativeProfileBusyError, type AgyNativeTurnScope } from './profile-turn/store.js';

/** Fence account preparation/startup or one conversation; release startup at verified init. */
export async function waitForAgyNativeProfileTurn(
  home: string,
  invocationId?: string,
  signal?: AbortSignal,
  scope?: AgyNativeTurnScope,
): Promise<() => Promise<void>> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await acquireAgyNativeProfileTurnAsync(home, invocationId, scope, signal);
    } catch (error) {
      if (!(error instanceof AgyNativeProfileBusyError)) throw error;
      await delay(250, undefined, { signal });
    }
  }
}

function isRetired(owner: ProfileTurnOwner, home: string): boolean {
  const exact = readUnixProcessSnapshotSync({ pids: [owner.identity.pid] });
  if (!exact || sameUnixProcess(owner.identity, exact.get(owner.identity.pid))) return false;
  const snapshot = readUnixProcessSnapshotSync({ includeEnvironment: true });
  return snapshot !== null && isNativeTurnRetiredFromSnapshot(owner, home, snapshot);
}

/** Account startup ends at init; conversation IDs fence their own live process across API instances. */
export function acquireAgyNativeProfileTurn(
  home: string,
  invocationId?: string,
  scope: AgyNativeTurnScope = {},
): () => void {
  const identity = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
  if (!identity) throw new Error('Native profile ownership requires a verified process birth identity');
  const { db, table, key, value } = openNativeTurnStore(home, scope);
  const token = randomUUID();
  try {
    db.transaction(() => {
      const previous = db.prepare(`SELECT owner FROM ${table} WHERE ${key} = ?`).get(value) as
        | { owner: string }
        | undefined;
      if (previous) {
        const owner = parseNativeTurnOwner(previous.owner, home);
        if (!isRetired(owner, home))
          throw new AgyNativeProfileBusyError('Another native turn still owns this conversation or preparation');
        // Death and absence of descendants are proven under the same transaction
        // that fences the successor. Never retire a live turn's MCP credential.
        if (!owner.preparation) retireOrphanCredentials(owner.runHome ?? home, home);
      }
      const owner: ProfileTurnOwner = {
        identity,
        dataRoot: resolveCatCafeDataRoot(),
        ...(invocationId ? { invocationId } : {}),
        ...(scope.runHome ? { runHome: scope.runHome } : {}),
        ...(scope.preparation ? { preparation: true } : {}),
      };
      db.prepare(
        `INSERT INTO ${table} (${key}, token, owner) VALUES (?, ?, ?) ON CONFLICT(${key}) DO UPDATE SET token = excluded.token, owner = excluded.owner`,
      ).run(value, token, JSON.stringify(owner));
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.prepare(`DELETE FROM ${table} WHERE ${key} = ? AND token = ?`).run(value, token);
    } finally {
      db.close();
    }
  };
}
