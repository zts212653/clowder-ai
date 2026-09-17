/** Pure per-ref snapshots; the selected account and credential never get re-read independently. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccountConfig, CredentialEntry } from '@cat-cafe/shared';
import {
  AccountStoreVerdictError,
  canonicalizeAccount,
  canonicalJson,
  malformedAccountStore,
  objectMap,
  parseLegacyProviderProfiles,
  parseLegacyProviderSecrets,
  parseStoredAccount,
  parseStoredCredential,
} from './account-store-format.js';
import { resolveAccountStoreTopology } from './account-store-topology.js';

function readMap(path: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return malformedAccountStore(path);
  }
  try {
    return objectMap(JSON.parse(content), path);
  } catch {
    return malformedAccountStore(path);
  }
}

interface StoreSnapshot {
  root: string;
  accounts: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

function readStore(root: string): StoreSnapshot {
  const path = (name: string) => resolve(root, '.cat-cafe', name);
  const catalog = readMap(path('cat-catalog.json'));
  return {
    root,
    accounts: {
      ...parseLegacyProviderProfiles(readMap(path('provider-profiles.json')), true),
      ...objectMap(catalog.accounts === undefined ? {} : catalog.accounts, path('cat-catalog.json accounts')),
      ...readMap(path('accounts.json')),
    },
    credentials: {
      ...parseLegacyProviderSecrets(readMap(path('provider-profiles.secrets.local.json')), true),
      ...readMap(path('credentials.json')),
    },
  };
}

export interface AccountEntrySnapshot {
  root: string;
  account?: AccountConfig;
  credential?: CredentialEntry;
  origin: 'canonical' | 'legacy' | 'both-equal' | 'absent';
}

export interface UnavailableAccount {
  accountRef: string;
  state: 'rejected';
  reason: string;
}

export type AccountEntryVerdict =
  | { accountRef: string; state: 'resolved'; entry: AccountEntrySnapshot }
  | UnavailableAccount;

function readEntry(store: StoreSnapshot, ref: string): AccountEntrySnapshot {
  for (const values of [store.accounts, store.credentials]) {
    if (Object.hasOwn(values, ref) && values[ref] instanceof AccountStoreVerdictError) throw values[ref];
  }
  return {
    root: store.root,
    origin: 'absent',
    ...(Object.hasOwn(store.accounts, ref)
      ? { account: parseStoredAccount(store.accounts[ref], `${store.root}/.cat-cafe account ${ref}`) }
      : {}),
    ...(Object.hasOwn(store.credentials, ref)
      ? { credential: parseStoredCredential(store.credentials[ref], `${store.root}/.cat-cafe credential ${ref}`) }
      : {}),
  };
}

function hasMaterial(entry: AccountEntrySnapshot): boolean {
  return entry.account !== undefined || entry.credential !== undefined;
}

function rejectOrphan(entry: AccountEntrySnapshot, ref: string): void {
  if (!entry.account && entry.credential) {
    throw new AccountStoreVerdictError(
      `account "${ref}" has a torn credential without account metadata; reconcile before use`,
    );
  }
}

function selectEntry(primary: StoreSnapshot, legacy: StoreSnapshot | undefined, ref: string): AccountEntrySnapshot {
  const a = readEntry(primary, ref);
  const b = legacy ? readEntry(legacy, ref) : undefined;
  rejectOrphan(a, ref);
  if (b) rejectOrphan(b, ref);
  if (b && hasMaterial(a) && hasMaterial(b)) {
    if (Boolean(a.account) !== Boolean(b.account) || Boolean(a.credential) !== Boolean(b.credential)) {
      throw new AccountStoreVerdictError(
        `account "${ref}" is torn across workspace/runtime stores; reconcile before use`,
      );
    }
    if (
      canonicalJson(a.account && canonicalizeAccount(a.account)) !==
        canonicalJson(b.account && canonicalizeAccount(b.account)) ||
      canonicalJson(a.credential) !== canonicalJson(b.credential)
    ) {
      throw new AccountStoreVerdictError(
        `account "${ref}" is divergent between workspace/runtime stores; reconcile before use`,
      );
    }
    return { ...a, origin: 'both-equal' };
  }
  const selected = b && hasMaterial(b) ? { ...b, origin: 'legacy' as const } : { ...a, origin: 'canonical' as const };
  return selected.account ? selected : { root: primary.root, origin: 'absent' };
}

export function readAccountStoreSnapshot(projectRoot?: string) {
  const topology = resolveAccountStoreTopology(projectRoot);
  const primary = readStore(topology.primaryRoot);
  const legacy = topology.legacyRoot ? readStore(topology.legacyRoot) : undefined;
  return {
    primaryRoot: primary.root,
    refs: [
      ...new Set([
        ...Object.keys(primary.accounts),
        ...Object.keys(primary.credentials),
        ...Object.keys(legacy?.accounts ?? {}),
        ...Object.keys(legacy?.credentials ?? {}),
      ]),
    ],
    resolve: (ref: string) => selectEntry(primary, legacy, ref),
    inspect: (ref: string): AccountEntryVerdict => {
      try {
        return { accountRef: ref, state: 'resolved', entry: selectEntry(primary, legacy, ref) };
      } catch (error) {
        if (!(error instanceof AccountStoreVerdictError)) throw error;
        return { accountRef: ref, state: 'rejected', reason: error.message };
      }
    },
  };
}

export function readAccountSnapshot(projectRoot: string, ref: string): AccountEntrySnapshot {
  return readAccountStoreSnapshot(projectRoot).resolve(ref);
}

/** Root cutover is an explicit operation, never a side effect of editing one account. */
export function assertAccountWritable(projectRoot: string, ref: string): void {
  const entry = readAccountSnapshot(projectRoot, ref);
  if (entry.origin === 'legacy' || entry.origin === 'both-equal') {
    throw new AccountStoreVerdictError(`account "${ref}" has a runtime copy; reconcile before editing`);
  }
}

/** Listing is partial; resolving or mutating a rejected ref still throws. */
export function inspectAccountCatalog(projectRoot: string) {
  const store = readAccountStoreSnapshot(projectRoot);
  const entries: Record<string, AccountEntrySnapshot & { account: AccountConfig }> = {};
  const unavailableAccounts: UnavailableAccount[] = [];
  for (const ref of store.refs) {
    const verdict = store.inspect(ref);
    if (verdict.state === 'rejected') unavailableAccounts.push(verdict);
    else if (verdict.entry.account) {
      Object.defineProperty(entries, ref, { value: verdict.entry, enumerable: true });
    }
  }
  return { entries, unavailableAccounts };
}

export function readAccountCatalogSnapshot(projectRoot: string): Record<string, AccountConfig> {
  return Object.fromEntries(
    Object.entries(inspectAccountCatalog(projectRoot).entries).map(([ref, entry]) => [ref, entry.account]),
  );
}
