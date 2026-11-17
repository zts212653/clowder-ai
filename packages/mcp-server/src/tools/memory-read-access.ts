import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReadRef } from '@cat-cafe/shared';
import { hasUsableAgentKeyCredentials } from '@cat-cafe/shared/utils';
import type { CanonicalToolsetEnv } from '../canonical-tool-registry.js';
import type { McpRuntimeProfile } from '../tool-governance-types.js';
import { currentWatcherAdmission, resolveInvocationEnv } from './invocation-auth.js';

const ownerProfiles = [
  'full',
  'agent-key',
  'desktop:fable-phase0',
  'desktop:cloud-pro-phase0',
  'desktop:live-companion',
] as const;
/** The original readers' qualifications, also used by the unified registration projection. */
export const MEMORY_READ_PROFILES: Readonly<Record<ReadRef['kind'], readonly McpRuntimeProfile[]>> = {
  message: ownerProfiles,
  profile: ownerProfiles,
  matter: ['full'],
  cue: ['full'],
  file: ['full', 'readonly', 'desktop:live-companion'],
};
const policy = new AsyncLocalStorage<CanonicalToolsetEnv & { watcher?: boolean }>();
export function withMemoryReadPolicy<T>(env: CanonicalToolsetEnv & { watcher?: boolean }, run: () => T): T {
  return policy.run(env, run);
}
/** A watcher only keeps its original callback routes; find groups outside them are not executable. */
export function isWatcherMemoryContext(): boolean {
  return Boolean(policy.getStore()?.watcher || currentWatcherAdmission());
}
export function canReadMemoryKind(kind: ReadRef['kind']): boolean {
  const bound = policy.getStore();
  const env = bound ?? {
    readonly: process.env.CAT_CAFE_READONLY === 'true',
    agentKeyUnion: process.env.CAT_CAFE_READONLY_AGENT_KEY_UNION === 'true',
    hasAgentKey: hasUsableAgentKeyCredentials(process.env),
  };
  if ((env.watcher || currentWatcherAdmission()) && !['message', 'profile', 'matter'].includes(kind)) return false;
  const profiles = MEMORY_READ_PROFILES[kind];
  const desktop = resolveInvocationEnv('CAT_CAFE_DESKTOP_MODE') ?? bound?.desktopMode;
  if (desktop) return profiles.includes(`desktop:${desktop}` as McpRuntimeProfile);
  if (!env.readonly) return profiles.includes('full');
  return (
    profiles.includes('readonly') || Boolean(env.agentKeyUnion && env.hasAgentKey && profiles.includes('agent-key'))
  );
}
