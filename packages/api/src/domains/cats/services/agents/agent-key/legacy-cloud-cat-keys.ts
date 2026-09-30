import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentKeyRegistry } from './AgentKeyRegistry.js';

/**
 * F202 W2-3 h3c-2 (review P1-2) — before agent keys carried a scope, every key of `gpt-pro` was a
 * cloud credential: the Host recognised the cloud cat by that id alone. Now a key is a cloud credential
 * only by its `cloud-conversation` scope, so those older keys are history. They are revoked — the one
 * the sidecar published, the rotation grace it left behind, any other — whatever the configuration
 * says, so none of them can ever pass as an ordinary key.
 *
 * "Older" is measured against the first reconciliation that ran this code. Its time is written once,
 * next to the key files, and read back on every later run, so a key issued after the upgrade — say an
 * ordinary key of a cat that happens to be called `gpt-pro` — is never touched.
 */

/** The one cloud cat the Host served before cloud cats were configurable. */
export const LEGACY_CLOUD_CAT_ID = 'gpt-pro';
const MARKER_FILE = 'cloud-scope-migration.json';
const REVOKED_AS_HISTORY = 'issued for the cloud cat before keys carried a scope';

async function readCutoff(file: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { v?: unknown; cutoff?: unknown };
    return parsed.v === 1 && typeof parsed.cutoff === 'number' && Number.isFinite(parsed.cutoff)
      ? parsed.cutoff
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The migration's cutoff: recorded by the first run, read back by every later one. `durable` is false
 * when it could not be recorded; that run then counts everything issued so far as history (the safe
 * side), and the next run tries to record it again.
 */
export async function cloudScopeMigrationCutoff(
  keyDir: string,
  now: () => number = Date.now,
): Promise<{ readonly cutoff: number; readonly durable: boolean }> {
  const file = join(keyDir, MARKER_FILE);
  const recorded = await readCutoff(file);
  if (recorded !== undefined) return { cutoff: recorded, durable: true };
  const cutoff = now();
  try {
    await mkdir(keyDir, { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ v: 1, cutoff })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { cutoff, durable: true };
  } catch {
    const raced = await readCutoff(file);
    return raced === undefined ? { cutoff, durable: false } : { cutoff: raced, durable: true };
  }
}

export interface PreScopeSweep {
  readonly keyDir: string;
  readonly now?: () => number;
  readonly log?: { warn(message: string): void };
}

/**
 * Revokes every still-valid key of the pre-scope cloud cat issued up to the cutoff; returns their ids.
 * Idempotent, and cheap enough to run wherever cloud keys are reconciled.
 */
export async function revokePreScopeCloudCatKeys(registry: AgentKeyRegistry, sweep: PreScopeSweep): Promise<string[]> {
  const migration = await cloudScopeMigrationCutoff(sweep.keyDir, sweep.now);
  if (!migration.durable) {
    sweep.log?.warn(
      '[api] could not record the cloud-scope migration cutoff; every pre-scope cloud key issued so far is revoked',
    );
  }
  const revoked: string[] = [];
  for (const record of await registry.list({ catId: LEGACY_CLOUD_CAT_ID })) {
    if (record.scope !== 'user-bound' || record.issuedAt > migration.cutoff) continue;
    if (await registry.revoke(record.agentKeyId, REVOKED_AS_HISTORY)) revoked.push(record.agentKeyId);
  }
  return revoked;
}
