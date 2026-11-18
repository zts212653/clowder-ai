import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionAccountSnapshot } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { CodexUsageItem } from '../routes/quota.js';
import { resolveAccountWriteRoot } from './account-store-topology.js';
import { resolveKimiQuotaExecutionOwner } from './kimi-quota-identity.js';
import { assertSafeTestConfigRoot } from './test-config-write-guard.js';

const kimiQuotaItemSchema = z
  .object({
    label: z.string().min(1).max(200),
    usedPercent: z.number().min(0).max(100),
    percentKind: z.enum(['used', 'remaining']).optional(),
    poolId: z.string().min(1).max(100).optional(),
    resetsAt: z.string().min(1).max(100).optional(),
    resetsText: z.string().min(1).max(200).optional(),
  })
  .strict();

const kimiQuotaItemsSchema = z.array(kimiQuotaItemSchema).min(1).max(10);

export interface KimiAccountQuotaObservationView {
  readonly owner: {
    readonly accountRef: string;
    readonly credentialVersion: string;
  };
  readonly observedAt: number;
  readonly items: CodexUsageItem[];
}

const pathFor = (root: string) => join(resolveAccountWriteRoot(root), '.cat-cafe', 'kimi-quota.sqlite');

export function readKimiQuota(
  root: string,
  accountRef: string,
  credentialVersion?: string,
): KimiAccountQuotaObservationView | undefined {
  if (!credentialVersion) return undefined;
  const path = pathFor(root);
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1500 });
  try {
    const row = db
      .prepare('SELECT observed_at, items_json FROM observations WHERE account_ref = ? AND credential_version = ?')
      .get(accountRef, credentialVersion) as { observed_at: number; items_json: string } | undefined;
    if (!row || !Number.isFinite(row.observed_at)) return undefined;
    const parsedItems = kimiQuotaItemsSchema.safeParse(JSON.parse(row.items_json));
    if (!parsedItems.success) return undefined;
    return {
      owner: { accountRef, credentialVersion },
      observedAt: row.observed_at,
      items: parsedItems.data,
    };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export function readKimiQuotaView(
  root: string,
  accountRef: string,
): { kimiLoginReady: boolean; kimiQuota?: KimiAccountQuotaObservationView } {
  try {
    const owner = resolveKimiQuotaExecutionOwner(root, accountRef);
    const credentialVersion = owner?.snapshot.credentialVersion;
    if (!credentialVersion) return { kimiLoginReady: false };
    const kimiQuota = readKimiQuota(root, accountRef, credentialVersion);
    return {
      kimiLoginReady: true,
      ...(kimiQuota ? { kimiQuota } : {}),
    };
  } catch {
    return { kimiLoginReady: false };
  }
}

export function recordKimiQuota(input: {
  root: string;
  account: ExecutionAccountSnapshot;
  items: unknown;
  observedAt: number;
}): boolean {
  const parsedItems = kimiQuotaItemsSchema.safeParse(input.items);
  if (
    !input.account.credentialVersion ||
    !parsedItems.success ||
    !Number.isFinite(input.observedAt) ||
    input.observedAt < 0
  ) {
    return false;
  }

  const current = resolveKimiQuotaExecutionOwner(input.root, input.account.accountRef);
  if (
    !current?.snapshot.credentialVersion ||
    current.snapshot.credentialVersion !== input.account.credentialVersion ||
    current.snapshot.accountRevision !== input.account.accountRevision
  ) {
    return false;
  }

  const writeRoot = resolveAccountWriteRoot(input.root);
  assertSafeTestConfigRoot(writeRoot, 'kimi-quota-observation');
  mkdirSync(join(writeRoot, '.cat-cafe'), { recursive: true, mode: 0o700 });
  const path = pathFor(input.root);
  const db = new Database(path, { timeout: 1500 });
  try {
    chmodSync(path, 0o600);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS observations (
      account_ref TEXT NOT NULL,
      credential_version TEXT NOT NULL,
      observed_at REAL NOT NULL,
      items_json TEXT NOT NULL,
      PRIMARY KEY (account_ref, credential_version)
    )`);
    return (
      db
        .prepare(`INSERT INTO observations VALUES (?, ?, ?, ?)
      ON CONFLICT (account_ref, credential_version) DO UPDATE SET
        observed_at = excluded.observed_at,
        items_json = excluded.items_json
      WHERE excluded.observed_at >= observations.observed_at`)
        .run(
          current.snapshot.accountRef,
          current.snapshot.credentialVersion,
          input.observedAt,
          JSON.stringify(parsedItems.data),
        ).changes > 0
    );
  } finally {
    db.close();
  }
}
