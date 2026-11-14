import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AccountQuotaObservation, accountQuotaOwnerMatches, type CodexAccountIdentity } from '@cat-cafe/shared';
import { z } from 'zod';
import { accountQuotaObservationSchema } from './account-store-format.js';
import { resolveAccountWriteRoot } from './account-store-topology.js';
import { assertSafeTestConfigRoot } from './test-config-write-guard.js';
import { writeFileAtomic } from './write-file-atomic.js';

const nativeQuotaSchema = z.object({ credentialHome: z.string(), quota: accountQuotaObservationSchema });

/** Quota is an observation of CLI-owned auth, never registration or a credential source. */
export function readNativeCodexQuota(
  root: string,
  home: string,
  identity: CodexAccountIdentity | undefined,
): AccountQuotaObservation | undefined {
  const path = join(resolveAccountWriteRoot(root), '.cat-cafe', 'native-codex-quota.json');
  try {
    const result = nativeQuotaSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success || result.data.credentialHome !== home) return undefined;
    const quota = result.data.quota;
    return quota.owner
      ? accountQuotaOwnerMatches(quota, 'codex', identity)
        ? quota
        : undefined
      : !identity && quota.status !== 'ok' && !quota.lastSuccess
        ? quota
        : undefined;
  } catch {
    // Missing or malformed optional observations must not hide the account directory.
    return undefined;
  }
}

export function writeNativeCodexQuota(root: string, credentialHome: string, quota: AccountQuotaObservation): void {
  const ownerRoot = resolveAccountWriteRoot(root);
  assertSafeTestConfigRoot(ownerRoot, 'native-codex-quota');
  const directory = join(ownerRoot, '.cat-cafe');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    join(directory, 'native-codex-quota.json'),
    `${JSON.stringify({ credentialHome, quota }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
