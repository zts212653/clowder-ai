import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountQuotaObservation,
  accountQuotaOwnerMatches,
  type CodexAccountIdentity,
  type ExecutionAccountSnapshot,
} from '@cat-cafe/shared';
import { pathsEqual } from '../utils/project-path.js';
import { resolveByAccountRef } from './account-resolver.js';
import { readAccountStoreSnapshot } from './account-store-snapshot.js';
import { resolveAccountWriteRoot } from './account-store-topology.js';
import { writeCatalogAccount } from './catalog-accounts.js';
import {
  codexIdentityFromAuth,
  codexManagedStatus,
  readCodexAccountIdentity,
  sameCodexIdentity,
} from './codex-account-identity.js';
import {
  type CodexAccountLaunchDescriptor,
  codexCanonicalPath,
  resolveCodexAccountLaunch,
} from './codex-account-launch.js';
import { overlayCodexSensitiveConfig, readCodexLaunchProjection } from './codex-launch-config.js';
import { readNativeCodexQuota, writeNativeCodexQuota } from './native-codex-quota.js';
import { assertSafeTestConfigRoot } from './test-config-write-guard.js';

export interface CodexSessionRateLimitWindowInput {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAtSeconds?: number;
}

export interface CodexSessionRateLimitsInput {
  readonly limitId: string;
  readonly observedAtMs?: number;
  readonly primary?: CodexSessionRateLimitWindowInput;
  readonly secondary?: CodexSessionRateLimitWindowInput;
}

export interface CodexPassiveQuotaLaunchContext {
  readonly root: string;
  readonly accountRef: string;
  readonly credentialHome: string;
  readonly managed: boolean;
  readonly launchIdentity: CodexAccountIdentity;
  readonly invocationStartedAt: number;
}

export interface CodexConfirmedQuotaTurnWindow {
  readonly sessionId: string;
  readonly turnId: string;
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface CodexPassiveQuotaTurnTracker {
  readonly appServerClientHooks: {
    readonly onBeforeTurnStart: (info: { threadId: string }) => Promise<void>;
    readonly onTurnAccepted: (info: { threadId: string; turnId: string }) => void;
    readonly onTurnUsageObserved: (info: { threadId: string; turnId: string }) => void;
    readonly onTurnEnded: () => Promise<void>;
  };
  confirmedWindowsFor(sessionId: string): readonly CodexConfirmedQuotaTurnWindow[];
}

const DISQUALIFYING_AUTO_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_APP_SERVER_TEST_USER_CONFIG_FILE',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL',
] as const;

function hasDisqualifyingAutoConfig(
  credentialHome: string,
  cwd: string,
  args: readonly string[],
  rpcConfig: Record<string, unknown> | undefined,
  nativeHome: string | undefined,
  workspaceId: string,
): boolean {
  if (args.some((arg) => arg === '--oss' || arg === '--local-provider' || arg.startsWith('--local-provider='))) {
    return true;
  }
  const projection = readCodexLaunchProjection(credentialHome, cwd, args, { nativeHome });
  const config = overlayCodexSensitiveConfig(projection.config, rpcConfig ?? {});
  if (config.cli_auth_credentials_store !== undefined && config.cli_auth_credentials_store !== 'file') return true;
  if (config.forced_login_method !== undefined && config.forced_login_method !== 'chatgpt') return true;
  if (config.openai_base_url !== undefined || config.chatgpt_base_url !== undefined) return true;
  if (
    config.model_provider !== undefined &&
    config.model_provider !== 'openai' &&
    config.model_provider !== 'openai_https'
  ) {
    return true;
  }
  if (config.forced_chatgpt_workspace_id && config.forced_chatgpt_workspace_id !== workspaceId) return true;
  return false;
}

function resolvePassiveAccountRef(
  accountLaunch: CodexAccountLaunchDescriptor,
  executionAccount?: ExecutionAccountSnapshot,
): string {
  return executionAccount?.accountRef ?? accountLaunch.accountRef ?? (accountLaunch.managed ? '' : 'codex');
}

function hasDisqualifyingEnv(env: Record<string, string | null | undefined>): boolean {
  return DISQUALIFYING_AUTO_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

/**
 * Freeze the verified OAuth account provenance BEFORE launching a Codex CLI invocation.
 * Supports both explicit `oauth` accounts and verified file-backed `auto` native logins,
 * while strictly excluding API-key, gateway, or non-file auth configurations.
 */
export function prepareCodexPassiveQuotaContext(input: {
  accountLaunch: CodexAccountLaunchDescriptor;
  executionAccount?: ExecutionAccountSnapshot;
  authMode: string;
  customBaseUrl?: string;
  customProvider: boolean;
  env: Record<string, string | null | undefined>;
  args: readonly string[];
  rpcConfig?: Record<string, unknown>;
  cwd: string;
}): CodexPassiveQuotaLaunchContext | null {
  try {
    const modeEligible = input.authMode === 'oauth' || input.authMode === 'auto';
    if (!modeEligible || input.customProvider || Boolean(input.customBaseUrl) || hasDisqualifyingEnv(input.env)) {
      return null;
    }

    const accountRef = resolvePassiveAccountRef(input.accountLaunch, input.executionAccount);
    const diskIdentity = accountRef ? readCodexAccountIdentity(input.accountLaunch.credentialHome) : null;
    if (!accountRef || !diskIdentity) return null;

    const declaredIdentity = input.executionAccount?.identity ?? input.accountLaunch.identity;
    if (declaredIdentity && !sameCodexIdentity(declaredIdentity, diskIdentity)) return null;

    const disqualifiedAuto =
      input.authMode === 'auto' &&
      hasDisqualifyingAutoConfig(
        input.accountLaunch.credentialHome,
        input.cwd,
        input.args,
        input.rpcConfig,
        input.env.HOME ?? undefined,
        diskIdentity.workspaceId,
      );
    if (disqualifiedAuto) return null;

    return {
      root: input.accountLaunch.accountOwnerRoot,
      accountRef,
      credentialHome: input.accountLaunch.credentialHome,
      managed: Boolean(input.accountLaunch.managed),
      launchIdentity: diskIdentity,
      invocationStartedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Tracks exact admitted app-server turn execution windows (each with a verified provider `turnId`)
 * so passive quota never attributes rollout bytes lacking a matching turn envelope or written during waits/retries.
 */
export function createCodexPassiveQuotaTurnTracker(input: {
  context: CodexPassiveQuotaLaunchContext;
  sessionsRoot: string;
  measureRolloutSize: (sessionId: string, sessionsRoot: string) => Promise<number>;
}): CodexPassiveQuotaTurnTracker {
  const confirmed: CodexConfirmedQuotaTurnWindow[] = [];
  let disarmed = false;
  let pendingAppStart: { sessionId: string; startByteOffset: number; startMs: number } | null = null;
  let openAppTurn: {
    sessionId: string;
    turnId: string;
    startByteOffset: number;
    startMs: number;
    usageConfirmed: boolean;
  } | null = null;

  const verifyDiskIdentityStillMatches = (): boolean => {
    if (disarmed) return false;
    const current = readCodexAccountIdentity(input.context.credentialHome);
    if (!current || !sameCodexIdentity(current, input.context.launchIdentity)) {
      disarmed = true;
      return false;
    }
    return true;
  };

  const closeAppTurn = async (): Promise<void> => {
    pendingAppStart = null;
    const closing = openAppTurn;
    openAppTurn = null;
    if (!closing || !closing.turnId || !closing.usageConfirmed || !verifyDiskIdentityStillMatches()) return;
    const endByteOffset = await input.measureRolloutSize(closing.sessionId, input.sessionsRoot);
    const endMs = Math.max(closing.startMs, Date.now());
    confirmed.push({
      sessionId: closing.sessionId,
      turnId: closing.turnId,
      startByteOffset: closing.startByteOffset,
      endByteOffset,
      startMs: closing.startMs,
      endMs,
    });
  };

  return {
    appServerClientHooks: {
      onBeforeTurnStart: async ({ threadId }) => {
        await closeAppTurn();
        if (!verifyDiskIdentityStillMatches()) return;
        const startByteOffset = await input.measureRolloutSize(threadId, input.sessionsRoot);
        pendingAppStart = { sessionId: threadId, startByteOffset, startMs: Date.now() };
      },
      onTurnAccepted: ({ threadId, turnId }) => {
        if (disarmed || !turnId || !pendingAppStart || pendingAppStart.sessionId !== threadId) return;
        openAppTurn = { ...pendingAppStart, turnId, usageConfirmed: false };
        pendingAppStart = null;
      },
      onTurnUsageObserved: ({ threadId, turnId }) => {
        if (openAppTurn && openAppTurn.sessionId === threadId && openAppTurn.turnId === turnId) {
          openAppTurn.usageConfirmed = true;
        }
      },
      onTurnEnded: closeAppTurn,
    },
    confirmedWindowsFor(sessionId) {
      return disarmed ? [] : confirmed.filter((w) => w.sessionId === sessionId);
    },
  };
}

function windowLabel(windowMinutes: number | undefined, fallback: string): string {
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return fallback;
  if (windowMinutes === 7 * 24 * 60) return '每周使用限额';
  if (windowMinutes % (24 * 60) === 0) return `${windowMinutes / (24 * 60)}天使用限额`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}小时使用限额`;
  return fallback;
}

function normalizeResetSeconds(seconds: number | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const date = new Date(Math.trunc(seconds * 1000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toWindowItem(
  win: CodexSessionRateLimitWindowInput | undefined,
  fallbackLabel: string,
): AccountQuotaObservation['items'][number] | null {
  if (!win) return null;
  const resetsAt = normalizeResetSeconds(win.resetsAtSeconds);
  return {
    label: windowLabel(win.windowMinutes, fallbackLabel),
    usedPercent: Math.max(0, Math.min(100, win.usedPercent)),
    percentKind: 'used',
    poolId: 'codex-main',
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function toMainQuotaItems(rateLimits: CodexSessionRateLimitsInput): AccountQuotaObservation['items'] {
  if (rateLimits.limitId !== 'codex') return [];
  const primary = toWindowItem(rateLimits.primary, '5小时使用限额');
  const secondary = toWindowItem(rateLimits.secondary, '每周使用限额');
  return [primary, secondary].filter((item): item is NonNullable<typeof item> => item !== null);
}

function hasOtherPools(previous: AccountQuotaObservation | undefined): boolean {
  const items = previous?.status === 'ok' ? previous.items : previous?.lastSuccess?.items;
  return Boolean(items?.some((item) => item.poolId && item.poolId !== 'codex-main'));
}

function readVerifiedAuth(
  launchHome: string,
  expectedIdentity: CodexAccountIdentity,
): { authIdentity: CodexAccountIdentity; credentialVersion: string } | null {
  const raw = readFileSync(join(launchHome, 'auth.json'), 'utf8');
  if (raw.length > 262_144) return null;
  const authIdentity = codexIdentityFromAuth(raw);
  if (!authIdentity || !sameCodexIdentity(expectedIdentity, authIdentity)) return null;
  const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } };
  const accessToken = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;
  if (typeof accessToken !== 'string' || !accessToken || typeof accountId !== 'string' || !accountId) return null;
  return {
    authIdentity,
    credentialVersion: createHash('sha256').update(accessToken).digest('hex'),
  };
}

function persistCatalogQuota(
  root: string,
  accountRef: string,
  launchHome: string,
  authIdentity: CodexAccountIdentity,
  observation: AccountQuotaObservation,
): boolean {
  const current = readAccountStoreSnapshot(root).resolve(accountRef).account;
  if (!current || current.authType !== 'oauth') return false;
  if (
    current.codex &&
    (codexManagedStatus(current.codex) !== 'ready' ||
      !pathsEqual(current.codex.credentialHome, launchHome) ||
      !sameCodexIdentity(current.codex.identity, authIdentity))
  ) {
    return false;
  }
  const previous = current.quota;
  if (
    previous &&
    accountQuotaOwnerMatches(previous, accountRef, authIdentity) &&
    (observation.observedAt < previous.observedAt || hasOtherPools(previous))
  ) {
    return false;
  }
  assertSafeTestConfigRoot(resolveAccountWriteRoot(root), 'codex-session-quota');
  writeCatalogAccount(root, accountRef, { ...current, quota: observation });
  return true;
}

function persistNativeQuota(
  root: string,
  launchHome: string,
  managed: boolean,
  authIdentity: CodexAccountIdentity,
  observation: AccountQuotaObservation,
): boolean {
  if (managed || !sameCodexIdentity(readCodexAccountIdentity(launchHome), authIdentity)) {
    return false;
  }
  const previous = readNativeCodexQuota(root, launchHome, authIdentity);
  if (previous && (observation.observedAt < previous.observedAt || hasOtherPools(previous))) return false;
  writeNativeCodexQuota(root, launchHome, observation);
  return true;
}

function validateObservedTimestamp(observedAt: number | undefined, invocationStartedAt?: number): number | null {
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt < 0) return null;
  if (invocationStartedAt !== undefined && observedAt < invocationStartedAt) return null;
  return observedAt;
}

/** Passively record Codex session rate_limits into the verified account quota store; never poll or cross-contaminate. */
export function observeCodexSessionQuota(input: {
  root: string;
  accountRef: string;
  credentialHome: string;
  managed: boolean;
  expectedIdentity: CodexAccountIdentity;
  invocationStartedAt?: number;
  rateLimits: CodexSessionRateLimitsInput | undefined;
}): boolean {
  try {
    const observedAt = validateObservedTimestamp(input.rateLimits?.observedAtMs, input.invocationStartedAt);
    if (!input.accountRef || !input.credentialHome || observedAt === null || !input.rateLimits) return false;
    const items = toMainQuotaItems(input.rateLimits);
    if (!items.length) return false;

    const resolved = resolveByAccountRef(input.root, input.accountRef);
    const eligible = resolved?.client === 'openai' && (resolved.syntheticNative || resolved.authType === 'oauth');
    if (!resolved || !eligible) return false;

    const launchHome = resolveCodexAccountLaunch(resolved, { cwd: input.root }).credentialHome;
    const verified = pathsEqual(launchHome, codexCanonicalPath(input.credentialHome, input.root))
      ? readVerifiedAuth(launchHome, input.expectedIdentity)
      : null;
    if (!verified) return false;

    const observation: AccountQuotaObservation = {
      owner: {
        accountRef: input.accountRef,
        userId: verified.authIdentity.userId,
        workspaceId: verified.authIdentity.workspaceId,
      },
      observedAt,
      status: 'ok',
      source: 'codex_official_readonly',
      items,
      credentialVersion: verified.credentialVersion,
    };

    return resolved.syntheticNative && input.accountRef === 'codex'
      ? persistNativeQuota(input.root, launchHome, input.managed, verified.authIdentity, observation)
      : persistCatalogQuota(input.root, input.accountRef, launchHome, verified.authIdentity, observation);
  } catch {
    return false;
  }
}
