import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeQuotaObservationSchema, type ExecutionAccountSnapshot } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { resolveByAccountRef } from './account-resolver.js';
import { resolveAccountWriteRoot } from './account-store-topology.js';
import { parseClaudeQuotaWindows } from './claude-quota-event.js';
import { claudeExecutionAccountSnapshot } from './claude-token-account.js';
import { assertSafeTestConfigRoot } from './test-config-write-guard.js';

const pathFor = (root: string) => join(resolveAccountWriteRoot(root), '.cat-cafe', 'claude-quota.sqlite');

/** Never reuse the old login's observation after a credential changes under the same ref. */
export function readClaudeQuota(root: string, accountRef: string, credentialVersion?: string) {
  if (!credentialVersion) return undefined;
  const path = pathFor(root);
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1500 });
  try {
    const rows = db
      .prepare(
        'SELECT model, observed_at, windows_json FROM observations WHERE account_ref = ? AND credential_version = ?',
      )
      .all(accountRef, credentialVersion) as { model: string; observed_at: number; windows_json: string }[];
    if (!rows.length) return undefined;
    const samples = Object.fromEntries(
      rows.map((row) => [row.model, { observedAt: row.observed_at, windows: JSON.parse(row.windows_json) }]),
    );
    const parsed = claudeQuotaObservationSchema.safeParse({ v: 1, accountRef, credentialVersion, samples });
    return parsed.success ? parsed.data : undefined;
  } finally {
    db.close();
  }
}

/** Missing/expired optional credentials must not hide the account row used to repair them. */
export async function readClaudeQuotaView(root: string, accountRef: string) {
  try {
    const profile = resolveByAccountRef(root, accountRef);
    if (!profile || profile.client !== 'anthropic') return undefined;
    const owner = await claudeExecutionAccountSnapshot(profile);
    const quota = readClaudeQuota(root, accountRef, owner.credentialVersion);
    return quota ? { samples: quota.samples } : undefined;
  } catch {
    return undefined;
  }
}

/** Per-model atomic writes also preserve observations from another runtime/Alpha process. */
export async function recordClaudeQuota(input: {
  root: string;
  account: ExecutionAccountSnapshot;
  model: string;
  windows: unknown;
  observedAt: number;
}): Promise<boolean> {
  const windows = parseClaudeQuotaWindows(input.windows);
  if (
    !input.account.credentialVersion ||
    !input.model ||
    input.model.length > 200 ||
    !windows ||
    !Number.isFinite(input.observedAt) ||
    input.observedAt < 0
  )
    return false;
  const current = resolveByAccountRef(input.root, input.account.accountRef);
  if (!current || current.client !== 'anthropic') return false;
  const owner = await claudeExecutionAccountSnapshot(current);
  if (
    !owner.credentialVersion ||
    owner.credentialVersion !== input.account.credentialVersion ||
    owner.accountRevision !== input.account.accountRevision
  )
    return false;
  const root = resolveAccountWriteRoot(input.root);
  assertSafeTestConfigRoot(root, 'claude-quota-observation');
  mkdirSync(join(root, '.cat-cafe'), { recursive: true, mode: 0o700 });
  const path = pathFor(input.root);
  const db = new Database(path, { timeout: 1500 });
  try {
    chmodSync(path, 0o600);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS observations (
      account_ref TEXT NOT NULL, credential_version TEXT NOT NULL, model TEXT NOT NULL,
      observed_at REAL NOT NULL, windows_json TEXT NOT NULL,
      PRIMARY KEY (account_ref, credential_version, model)
    )`);
    return (
      db
        .prepare(`INSERT INTO observations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_ref, credential_version, model) DO UPDATE SET
        observed_at = excluded.observed_at, windows_json = excluded.windows_json
      WHERE excluded.observed_at >= observations.observed_at`)
        .run(owner.accountRef, owner.credentialVersion, input.model, input.observedAt, JSON.stringify(windows))
        .changes > 0
    );
  } finally {
    db.close();
  }
}

/** Both official CLI and SDK use the same normalized event, with the frozen launch owner. */
export async function observeClaudeQuotaMessage(
  root: string,
  account: ExecutionAccountSnapshot | undefined,
  model: string,
  message: { type: string; content?: string; timestamp: number },
  sourceKnown?: () => boolean,
): Promise<void> {
  if (!account?.credentialVersion || message.type !== 'system_info' || !message.content) return;
  try {
    const data: unknown = JSON.parse(message.content);
    if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'rate_limit' || !('windows' in data))
      return;
    if (sourceKnown && !sourceKnown()) return;
    await recordClaudeQuota({ root, account, model, windows: data.windows, observedAt: message.timestamp });
  } catch {
    // Optional observations must not fail a model invocation or leak credential resolver errors.
  }
}
