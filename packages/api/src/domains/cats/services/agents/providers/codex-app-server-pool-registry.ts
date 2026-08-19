import { CodexAppServerHostPool, type CodexAppServerHostPoolConfig } from './CodexAppServerHostPool.js';

export const DEFAULT_CODEX_APP_SERVER_IDLE_TTL_MS = 300_000;
export const DEFAULT_CODEX_APP_SERVER_MAX_WARM_HOSTS = 16;

interface ClosableCodexAppServerPool {
  closeAll(): Promise<void>;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export type CodexAppServerPoolRegistry = Map<string, CodexAppServerHostPool>;

export function resolveCodexAppServerPoolConfig(env: EnvSource = process.env): CodexAppServerHostPoolConfig {
  return {
    idleTtlMs: parseNonNegativeInteger(env.CAT_CAFE_CODEX_APP_SERVER_IDLE_TTL_MS, DEFAULT_CODEX_APP_SERVER_IDLE_TTL_MS),
    maxWarmHosts: parseNonNegativeInteger(
      env.CAT_CAFE_CODEX_APP_SERVER_MAX_WARM_HOSTS,
      DEFAULT_CODEX_APP_SERVER_MAX_WARM_HOSTS,
    ),
  };
}

export function getOrCreateCodexAppServerPool<TPool extends ClosableCodexAppServerPool = CodexAppServerHostPool>(
  registry: Map<string, TPool>,
  profileId: string,
  factory: (config: CodexAppServerHostPoolConfig) => TPool = ((config: CodexAppServerHostPoolConfig) =>
    new CodexAppServerHostPool(config)) as unknown as (config: CodexAppServerHostPoolConfig) => TPool,
  env: EnvSource = process.env,
): TPool {
  const existing = registry.get(profileId);
  if (existing) return existing;
  const pool = factory(resolveCodexAppServerPoolConfig(env));
  registry.set(profileId, pool);
  return pool;
}

export async function closeStaleCodexAppServerPools<TPool extends ClosableCodexAppServerPool>(
  registry: Map<string, TPool>,
  activeProfileIds: ReadonlySet<string>,
  onCloseError?: (err: unknown, profileId: string) => void,
): Promise<string[]> {
  const closedProfileIds: string[] = [];
  for (const [profileId, pool] of [...registry.entries()]) {
    if (activeProfileIds.has(profileId)) continue;
    try {
      await pool.closeAll();
    } catch (err) {
      onCloseError?.(err, profileId);
    } finally {
      registry.delete(profileId);
      closedProfileIds.push(profileId);
    }
  }
  return closedProfileIds;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
