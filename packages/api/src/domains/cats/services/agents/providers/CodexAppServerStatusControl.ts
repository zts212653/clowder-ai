import type {
  AgentCarrierSession,
  ProviderNativeAvailability,
  ProviderNativeStatus,
  ProviderNativeThreadFork,
} from '../../types.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';
import { runCodexAppServerNativeRpc } from './CodexAppServerNativeRpc.js';

const THREAD_STATUSES = new Set(['notLoaded', 'idle', 'systemError', 'active']);
const ACCOUNT_KINDS = new Set(['apiKey', 'chatgpt', 'amazonBedrock']);

export async function requestCodexAppServerStatus(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly observedAt?: number;
}): Promise<ProviderNativeStatus> {
  return runCodexAppServerNativeRpc({
    wire: input.wire,
    threadId: input.threadId,
    timeoutMs: input.timeoutMs,
    run: async (client, resumed) => {
      const settled = await Promise.allSettled([
        client.request('thread/read', { threadId: input.threadId, includeTurns: false }),
        client.request('modelProvider/capabilities/read', {}),
        client.request('permissionProfile/list', { ...(input.cwd ? { cwd: input.cwd } : {}) }),
        client.request('account/read', { refreshToken: false }),
        client.request('account/rateLimits/read', {}),
        client.request('thread/list', { limit: 100, useStateDbOnly: true }),
      ]);
      return {
        runtimeSessionId: input.threadId,
        source: 'codex_app_server',
        observedAt: input.observedAt ?? Date.now(),
        thread: projectSettled(settled[0], projectThread),
        capabilities: projectSettled(settled[1], projectCapabilities),
        permissionProfiles: projectSettled(settled[2], (value) => projectProfiles(value, resumed)),
        account: projectSettled(settled[3], projectAccount),
        rateLimits: projectSettled(settled[4], projectRateLimits),
        nativeThreadList: projectSettled(settled[5], (value) => projectThreadList(value, input.threadId)),
      };
    },
  });
}

export async function requestCodexAppServerFork(input: {
  readonly wire: AgentCarrierSession;
  readonly threadId: string;
  readonly timeoutMs: number;
  readonly observedAt?: number;
}): Promise<ProviderNativeThreadFork> {
  return runCodexAppServerNativeRpc({
    wire: input.wire,
    threadId: input.threadId,
    timeoutMs: input.timeoutMs,
    run: async (client) => {
      const response = asCodexAppServerRecord(
        await client.request('thread/fork', {
          threadId: input.threadId,
          excludeTurns: true,
          deferGoalContinuation: true,
        }),
      );
      const thread = asCodexAppServerRecord(response?.thread);
      if (typeof thread?.id !== 'string' || thread.id.length === 0 || thread.forkedFromId !== input.threadId) {
        throw new Error('authoritative_native_fork_response_invalid');
      }
      return {
        sourceRuntimeSessionId: input.threadId,
        forkedRuntimeSessionId: thread.id,
        source: 'codex_app_server',
        observedAt: input.observedAt ?? Date.now(),
      };
    },
  });
}

function projectSettled<T extends object>(
  result: PromiseSettledResult<unknown>,
  projector: (value: unknown) => T | null,
): ProviderNativeAvailability<T> {
  if (result.status === 'rejected') return { availability: 'unavailable', reason: 'provider_request_failed' };
  const value = projector(result.value);
  return value ? { availability: 'available', ...value } : { availability: 'unavailable', reason: 'invalid_response' };
}

function projectThread(value: unknown) {
  const thread = asCodexAppServerRecord(asCodexAppServerRecord(value)?.thread);
  const status = asCodexAppServerRecord(thread?.status)?.type;
  if (!THREAD_STATUSES.has(String(status))) return null;
  const directInput = thread?.canAcceptDirectInput;
  if (directInput !== null && typeof directInput !== 'boolean') return null;
  return {
    status: status as 'notLoaded' | 'idle' | 'systemError' | 'active',
    canAcceptDirectInput: directInput,
  };
}

function projectCapabilities(value: unknown) {
  const response = asCodexAppServerRecord(value);
  if (
    typeof response?.imageGeneration !== 'boolean' ||
    typeof response.namespaceTools !== 'boolean' ||
    typeof response.webSearch !== 'boolean'
  ) {
    return null;
  }
  return {
    imageGeneration: response.imageGeneration,
    namespaceTools: response.namespaceTools,
    webSearch: response.webSearch,
  };
}

function projectProfiles(value: unknown, resumed: unknown) {
  const data = asCodexAppServerRecord(value)?.data;
  if (!Array.isArray(data)) return null;
  const profiles: Array<{ id: string; allowed: boolean }> = [];
  for (const candidate of data) {
    const profile = asCodexAppServerRecord(candidate);
    if (typeof profile?.id !== 'string' || typeof profile.allowed !== 'boolean') return null;
    profiles.push({ id: profile.id, allowed: profile.allowed });
  }
  const active = asCodexAppServerRecord(asCodexAppServerRecord(resumed)?.activePermissionProfile);
  return { activeId: typeof active?.id === 'string' ? active.id : null, profiles };
}

function projectAccount(value: unknown) {
  const response = asCodexAppServerRecord(value);
  if (typeof response?.requiresOpenaiAuth !== 'boolean') return null;
  if (response.account === null || response.account === undefined) return { authenticated: false };
  const account = asCodexAppServerRecord(response.account);
  if (!ACCOUNT_KINDS.has(String(account?.type))) return null;
  return {
    authenticated: true,
    kind: account?.type as 'apiKey' | 'chatgpt' | 'amazonBedrock',
    ...(typeof account?.planType === 'string' ? { plan: account.planType } : {}),
  };
}

function projectRateLimits(value: unknown) {
  const limits = asCodexAppServerRecord(asCodexAppServerRecord(value)?.rateLimits);
  if (!limits) return null;
  const primary = projectRateWindow(limits.primary);
  const secondary = projectRateWindow(limits.secondary);
  if (primary === undefined || secondary === undefined) return null;
  return {
    primary,
    secondary,
    reachedType: typeof limits.rateLimitReachedType === 'string' ? limits.rateLimitReachedType : null,
  };
}

function projectRateWindow(value: unknown): { usedPercent: number; resetsAt: number | null } | null | undefined {
  if (value === null || value === undefined) return null;
  const window = asCodexAppServerRecord(value);
  if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return undefined;
  if (window.resetsAt !== null && window.resetsAt !== undefined && typeof window.resetsAt !== 'number')
    return undefined;
  return { usedPercent: window.usedPercent, resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null };
}

function projectThreadList(value: unknown, boundThreadId: string) {
  const response = asCodexAppServerRecord(value);
  if (!Array.isArray(response?.data)) return null;
  const ids = response.data.map((candidate) => asCodexAppServerRecord(candidate)?.id);
  if (ids.some((id) => typeof id !== 'string')) return null;
  return {
    count: ids.length,
    boundThreadPresent: ids.includes(boundThreadId),
    hasMore: typeof response.nextCursor === 'string' && response.nextCursor.length > 0,
  };
}
