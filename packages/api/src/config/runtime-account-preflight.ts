/** Inspect active catalog bindings before the launcher replaces working processes. */
import { existsSync } from 'node:fs';
import { builtinAccountFamilyForRef } from '@cat-cafe/shared';
import { readAccountStoreSnapshot, type UnavailableAccount } from './account-store-snapshot.js';
import { resolveBoundAccountRefForCat } from './cat-account-binding.js';
import { resolveCatCatalogPath } from './cat-catalog-store.js';
import { loadResolvedCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

export interface RejectedRuntimeBinding {
  catId: string;
  accountRef: string;
  reason: string;
}

export interface RuntimeAccountPreflight {
  checkedBindings: number;
  rejectedBindings: RejectedRuntimeBinding[];
  unboundRejectedAccounts: UnavailableAccount[];
}

export type LiveAccountAvailability =
  | { state: 'unreachable' }
  | { state: 'legacy' }
  | { state: 'current'; rejectedAccountRefs: string[] };

/** A bounded, local read. A failed probe is unknown, never evidence of new loss. */
export async function readLiveAccountAvailability(port: number): Promise<LiveAccountAvailability> {
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { state: 'unreachable' };
    const response = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) return { state: 'unreachable' };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('providers' in body) || !Array.isArray(body.providers)) {
      return { state: 'unreachable' };
    }
    if (!('unavailableAccounts' in body)) return { state: 'legacy' };
    if (!Array.isArray(body.unavailableAccounts)) return { state: 'unreachable' };
    const rejectedAccountRefs: string[] = [];
    for (const item of body.unavailableAccounts) {
      if (!item || typeof item !== 'object' || typeof item.accountRef !== 'string') return { state: 'unreachable' };
      rejectedAccountRefs.push(item.accountRef);
    }
    return { state: 'current', rejectedAccountRefs };
  } catch {
    return { state: 'unreachable' };
  }
}

export function newlyRejectedRuntimeBindings(
  candidate: RuntimeAccountPreflight,
  live: LiveAccountAvailability,
): RejectedRuntimeBinding[] {
  if (live.state === 'unreachable') return [];
  const previous = new Set(live.state === 'current' ? live.rejectedAccountRefs : []);
  return candidate.rejectedBindings.filter((item) => !previous.has(item.accountRef));
}

function activeBindings(projectRoot: string): Array<Pick<RejectedRuntimeBinding, 'catId' | 'accountRef'>> {
  // No catalog means first install; template menu entries are not live members.
  if (!existsSync(resolveCatCatalogPath(projectRoot))) return [];
  const config = loadResolvedCatConfig(resolveProjectTemplatePath(projectRoot), { persistMigrations: false });
  return Object.values(toAllCatConfigs(config)).flatMap((cat) => {
    if (config.version === 2 && config.roster?.[cat.id]?.available === false) return [];
    const accountRef = resolveBoundAccountRefForCat(projectRoot, cat.id, cat);
    // Unbound CLIs retain their existing login/discovery behavior.
    return accountRef ? [{ catId: cat.id, accountRef }] : [];
  });
}

export function inspectRuntimeAccountBindings(projectRoot: string): RuntimeAccountPreflight {
  const store = readAccountStoreSnapshot(projectRoot);
  const bindings = activeBindings(projectRoot);
  const result: RuntimeAccountPreflight = {
    checkedBindings: bindings.length,
    rejectedBindings: [],
    unboundRejectedAccounts: [],
  };
  const bound = new Set<string>();
  for (const binding of bindings) {
    bound.add(binding.accountRef);
    const verdict = store.inspect(binding.accountRef);
    if (verdict.state === 'rejected') {
      result.rejectedBindings.push({ ...binding, reason: verdict.reason });
    } else if (!verdict.entry.account && !builtinAccountFamilyForRef(binding.accountRef)) {
      result.rejectedBindings.push({ ...binding, reason: 'bound account metadata is absent' });
    }
  }
  for (const ref of store.refs) {
    if (bound.has(ref)) continue;
    const verdict = store.inspect(ref);
    if (verdict.state === 'rejected') result.unboundRejectedAccounts.push(verdict);
  }
  return result;
}
