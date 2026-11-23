import { existsSync, realpathSync } from 'node:fs';
import { builtinAccountIdForClient, type CatConfig, type ExecutionAccountSnapshot } from '@cat-cafe/shared';
import { resolveAgyProfile } from '../domains/cats/services/agents/providers/agy-profile-manager.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { pathsEqual } from '../utils/project-path.js';
import { type RuntimeProviderProfile, resolveByAccountRef } from './account-resolver.js';
import { readAccountSnapshot } from './account-store-snapshot.js';
import {
  type AgySecurityExec,
  type AgyVerifiedOAuthDigests,
  inspectAgyOAuthFileIdentity,
  inspectAgyPrivateKeychainIdentity,
  sha256Hex,
} from './agy-oauth-payload-digest.js';
import { resolveCatCatalogPath } from './cat-catalog-store.js';
import { loadCatConfig, toAllCatConfigs } from './cat-config-loader.js';

export type AgyKeychainIdentityInspector = (profileHome: string) => Promise<string | undefined> | string | undefined;

export interface AgyQuotaOwnerOptions {
  readonly keychainIdentityInspector?: AgyKeychainIdentityInspector;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly securityExec?: AgySecurityExec;
}

export interface AgyQuotaSampleTarget {
  readonly kind: 'cli_file' | 'native_profile';
  readonly homePath: string;
  readonly usesKeychain: boolean;
}

export interface AgyQuotaExecutionOwner {
  readonly snapshot: ExecutionAccountSnapshot;
  readonly target: AgyQuotaSampleTarget;
}

type NativeAuthMode = 'keychain' | 'ssh_file' | 'unsupported';

export function hasInheritedSshAuthEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_TTY?.trim() || env.SSH_CLIENT?.trim() || env.SSH_CONNECTION?.trim());
}

export function resolveNativeProfileAuthMode(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NativeAuthMode {
  if (hasInheritedSshAuthEnv(env)) return 'ssh_file';
  if (platform === 'darwin') return 'keychain';
  return 'unsupported';
}

function isRuntimeRedirectedWorkspace(projectRoot: string, activeRoot: string): boolean {
  if (pathsEqual(projectRoot, activeRoot)) return true;
  const runtimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT?.trim();
  const workspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  return Boolean(
    runtimeRoot && workspaceRoot && pathsEqual(activeRoot, runtimeRoot) && pathsEqual(projectRoot, workspaceRoot),
  );
}

function resolveCatalogPathForAgyMembers(projectRoot: string): string | null {
  try {
    const activeRoot = resolveActiveProjectRoot();
    if (isRuntimeRedirectedWorkspace(projectRoot, activeRoot)) {
      const activeCatalog = resolveCatCatalogPath(activeRoot);
      if (existsSync(activeCatalog)) return activeCatalog;
    }
  } catch {
    // Ignore unresolvable active root in isolated unit tests.
  }
  const direct = resolveCatCatalogPath(projectRoot);
  return existsSync(direct) ? direct : null;
}

async function inspectNativeProfileIdentity(
  resolvedHome: string,
  authMode: NativeAuthMode,
  options?: AgyQuotaOwnerOptions,
): Promise<AgyVerifiedOAuthDigests | null> {
  if (authMode === 'ssh_file') {
    return inspectAgyOAuthFileIdentity(resolvedHome);
  }
  if (authMode === 'keychain') {
    if (options?.keychainIdentityInspector) {
      const raw = (await options.keychainIdentityInspector(resolvedHome))?.trim();
      if (!raw) return null;
      const digest = sha256Hex(`keychain_custom:${raw}`);
      return { principalDigest: digest, grantDigest: digest };
    }
    return inspectAgyPrivateKeychainIdentity(resolvedHome, {
      platform: options?.platform,
      securityExec: options?.securityExec,
    });
  }
  return null;
}

function resolveCandidateProfileHome(cat: CatConfig, projectRoot: string): string | null {
  if (cat.agyProfile?.enabled === false || cat.agyProfile?.carrier !== 'native' || cat.carrier === 'acp') {
    return null;
  }
  const model = cat.agyProfile?.model?.trim() || cat.defaultModel;
  if (!model) return null;
  try {
    const profile = resolveAgyProfile({
      materializeSettings: false,
      catId: cat.id,
      expectedModel: model,
      workingDirectory: projectRoot,
      config: cat.agyProfile ?? undefined,
    });
    if (!profile || !existsSync(profile.homePath)) return null;
    return realpathSync(profile.homePath);
  } catch {
    return null;
  }
}

function selectBoundGoogleCandidates(catalog: ReturnType<typeof loadCatConfig>, accountRef: string): CatConfig[] {
  const defaultGoogleRef = builtinAccountIdForClient('google') ?? 'gemini';
  const bound = Object.values(toAllCatConfigs(catalog)).filter(
    (cat) =>
      cat.id !== 'gpt-pro' &&
      Boolean(cat.cli || cat.carrier === 'acp' || cat.agyProfile) &&
      cat.clientId === 'google' &&
      (cat.accountRef ?? defaultGoogleRef) === accountRef,
  );
  const active = bound.filter((cat) => catalog.version !== 2 || catalog.roster[cat.id]?.available !== false);
  return active.length > 0 ? active : bound;
}

function collectCandidateHomes(
  candidates: readonly CatConfig[],
  projectRoot: string,
  usesKeychain: boolean,
):
  | { ok: true; primaryTarget: AgyQuotaSampleTarget; uniqueHomes: string[] }
  | { ok: false; target?: AgyQuotaSampleTarget } {
  const uniqueHomes: string[] = [];
  const seenHomes = new Set<string>();
  let primaryTarget: AgyQuotaSampleTarget | undefined;

  for (const cat of candidates) {
    const resolvedHome = resolveCandidateProfileHome(cat, projectRoot);
    if (!resolvedHome) return { ok: false, target: primaryTarget };
    primaryTarget ??= { kind: 'native_profile', homePath: resolvedHome, usesKeychain };
    if (!seenHomes.has(resolvedHome)) {
      seenHomes.add(resolvedHome);
      uniqueHomes.push(resolvedHome);
    }
  }
  return primaryTarget ? { ok: true, primaryTarget, uniqueHomes } : { ok: false };
}

async function resolveNativeProfileOwner(
  projectRoot: string,
  accountRef: string,
  options?: AgyQuotaOwnerOptions,
): Promise<{ credentialVersion?: string; target: AgyQuotaSampleTarget } | null> {
  const authMode = resolveNativeProfileAuthMode(options?.platform, options?.env);
  const usesKeychain = authMode === 'keychain';
  const fallbackTarget: AgyQuotaSampleTarget = { kind: 'native_profile', homePath: projectRoot, usesKeychain };
  if (authMode === 'unsupported') return { target: fallbackTarget };

  const catalogPath = resolveCatalogPathForAgyMembers(projectRoot);
  if (!catalogPath) return null;
  let catalog: ReturnType<typeof loadCatConfig>;
  try {
    catalog = loadCatConfig(catalogPath);
  } catch {
    return null;
  }
  const candidates = selectBoundGoogleCandidates(catalog, accountRef);
  if (candidates.length === 0) return null;

  const homesResult = collectCandidateHomes(candidates, projectRoot, usesKeychain);
  if (!homesResult.ok) return { target: homesResult.target ?? fallbackTarget };
  const { primaryTarget, uniqueHomes } = homesResult;

  const inspected = await Promise.all(
    uniqueHomes.map(async (home) => ({
      home,
      identity: await inspectNativeProfileIdentity(home, authMode, options),
    })),
  );

  const principalDigests = new Set<string>();
  const profileGrants: Array<{ home: string; grantDigest: string }> = [];
  for (const entry of inspected) {
    if (!entry.identity) return { target: primaryTarget };
    principalDigests.add(entry.identity.principalDigest);
    profileGrants.push({ home: entry.home, grantDigest: entry.identity.grantDigest });
  }

  if (principalDigests.size !== 1) {
    return { target: primaryTarget };
  }
  const [singlePrincipalDigest] = [...principalDigests];
  profileGrants.sort((a, b) => a.home.localeCompare(b.home));
  const credentialVersion = sha256Hex(
    JSON.stringify({
      mode: 'native_profile',
      authMode,
      accountRef,
      principalDigest: singlePrincipalDigest,
      profileGrants,
    }),
  );
  return { credentialVersion, target: primaryTarget };
}

function buildCliFileOwner(profile: RuntimeProviderProfile, rawHome: string): AgyQuotaExecutionOwner | null {
  let canonicalHome: string;
  try {
    canonicalHome = realpathSync(rawHome);
  } catch {
    return null;
  }
  const identity = inspectAgyOAuthFileIdentity(canonicalHome);
  const credentialVersion = identity
    ? sha256Hex(
        JSON.stringify({
          mode: 'cli_file',
          credentialHome: canonicalHome,
          principalDigest: identity.principalDigest,
          grantDigest: identity.grantDigest,
        }),
      )
    : undefined;
  const accountRevision = sha256Hex(
    JSON.stringify({
      id: profile.id,
      authType: profile.authType,
      credentialHome: canonicalHome,
      credentialVersion: credentialVersion ?? null,
    }),
  );
  return Object.freeze({
    snapshot: Object.freeze({
      accountRef: profile.id,
      displayName: profile.displayName ?? profile.id,
      authType: profile.authType,
      accountRevision,
      ...(credentialVersion ? { credentialVersion } : {}),
    }),
    target: Object.freeze({ kind: 'cli_file', homePath: canonicalHome, usesKeychain: false }),
  });
}

export async function resolveAgyQuotaExecutionOwner(
  projectRoot: string,
  accountRef: string,
  options?: AgyQuotaOwnerOptions,
): Promise<AgyQuotaExecutionOwner | null> {
  if (readAccountSnapshot(projectRoot, accountRef).account?.googleCloud) return null;
  const profile = resolveByAccountRef(projectRoot, accountRef);
  if (!profile || profile.client !== 'google' || profile.authType !== 'oauth' || profile.baseUrl) {
    return null;
  }
  if (profile.agy) return buildCliFileOwner(profile, profile.agy.credentialHome);

  const defaultGoogleRef = builtinAccountIdForClient('google') ?? 'gemini';
  if (accountRef !== defaultGoogleRef) return null;

  const nativeOwner = await resolveNativeProfileOwner(projectRoot, accountRef, options);
  const credentialVersion = nativeOwner?.credentialVersion;
  const accountRevision = sha256Hex(
    JSON.stringify({
      id: profile.id,
      authType: profile.authType,
      mode: 'native_profile',
      credentialVersion: credentialVersion ?? null,
    }),
  );
  return Object.freeze({
    snapshot: Object.freeze({
      accountRef: profile.id,
      displayName: profile.displayName ?? profile.id,
      authType: profile.authType,
      accountRevision,
      ...(credentialVersion ? { credentialVersion } : {}),
    }),
    target: Object.freeze<AgyQuotaSampleTarget>(
      nativeOwner?.target ?? {
        kind: 'native_profile',
        homePath: projectRoot,
        usesKeychain: resolveNativeProfileAuthMode(options?.platform, options?.env) === 'keychain',
      },
    ),
  });
}
