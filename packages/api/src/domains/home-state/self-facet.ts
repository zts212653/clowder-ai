import { hostname } from 'node:os';
import type {
  Freshness,
  HomeStateSelfFacet,
  HostDependency,
  HostPlatform,
  QuotaFacet,
  RuntimeRevision,
  TypedAbsent,
} from '@cat-cafe/shared';

/**
 * F300 Task 1.1 — build the cat's own facet as a pure projection.
 *
 * Every source is injected, so this module owns no truth of its own: it selects
 * owner facts, stamps them with freshness, and returns. Nothing is cached and
 * nothing is written, which is what keeps "one truth per fact" true (KD-12/14) —
 * a stored snapshot would immediately become a second, staler answer.
 */

/** What a resolver hands back: the owner's fields plus where they came from. */
type Observed<T> = T & { readonly sourceRef: string; readonly observedAt?: number; readonly expiresAt?: number };

type Resolver<T> = () => T | Promise<T>;

export interface InstallationSource {
  readonly projectRoot: string;
  readonly deploymentId?: string;
}

export interface RuntimeSource {
  readonly worktree: string;
  readonly head: RuntimeRevision;
  readonly apiPid?: number;
  readonly apiPort?: number;
}

export interface PlatformSource {
  readonly os: HostPlatform;
  readonly arch: string;
  readonly hostNodeId: string;
}

export interface QuotaSource {
  readonly status: 'ok' | 'low' | 'exhausted';
  readonly poolRef: string;
}

export interface SelfFacetDeps {
  readonly installation: Resolver<Observed<InstallationSource>>;
  readonly runtimeStatus: Resolver<Observed<RuntimeSource>>;
  readonly invocation: { readonly threadId?: string; readonly invocationId?: string; readonly catId: string };
  /** The quota owner. Absent, expired or unreachable all stay distinguishable. */
  readonly quota?: Resolver<Observed<QuotaSource> | TypedAbsent | null | undefined>;
  readonly platform?: Resolver<Observed<PlatformSource>>;
  /** Extra host dependencies (redis, cli, daemon) the caller has evidence for. */
  readonly hostDependencies?: Resolver<readonly HostDependency[]>;
  readonly heldLeases?: Resolver<readonly string[] | TypedAbsent>;
  readonly now?: () => number;
}

const TYPED_ABSENT: readonly TypedAbsent[] = ['unknown', 'stale', 'conflict', 'not_authorized', 'owner_unreachable'];

function isTypedAbsent(value: unknown): value is TypedAbsent {
  return typeof value === 'string' && (TYPED_ABSENT as readonly string[]).includes(value);
}

/** Prefer the owner's own observation time; fall back to when we read it. */
function freshnessOf(observed: { sourceRef: string; observedAt?: number; expiresAt?: number }, now: number): Freshness {
  return {
    observedAt: observed.observedAt ?? now,
    ...(observed.expiresAt === undefined ? {} : { expiresAt: observed.expiresAt }),
    sourceRef: observed.sourceRef,
  };
}

function defaultPlatform(): Observed<PlatformSource> {
  return {
    os: process.platform as HostPlatform,
    arch: process.arch,
    hostNodeId: hostname(),
    sourceRef: `process:${process.pid}#platform`,
  };
}

/**
 * Resolve the quota owner without ever guessing on its behalf.
 *
 * A throwing resolver means the owner could not be reached — which is not the
 * same as "no quota pool configured", and must not read as "quota is fine".
 * An expired observation degrades to `unknown` (spec §3): a cacheable fact past
 * its expiry has no remaining authority to say we still have budget.
 */
async function resolveQuota(deps: SelfFacetDeps, now: number): Promise<QuotaFacet> {
  if (!deps.quota) return 'unknown';
  let observed: Observed<QuotaSource> | TypedAbsent | null | undefined;
  try {
    observed = await deps.quota();
  } catch {
    return 'owner_unreachable';
  }
  if (observed === null || observed === undefined) return 'unknown';
  if (isTypedAbsent(observed)) return observed;

  const freshness = freshnessOf(observed, now);
  if (freshness.expiresAt !== undefined && freshness.expiresAt <= now) return 'unknown';
  return { status: observed.status, poolRef: observed.poolRef, ...freshness };
}

/**
 * Host dependencies are evidence-driven: an api entry only exists when the
 * runtime source actually produced a pid or a port. Listing a dependency we
 * cannot identify would be exactly the fabrication AC-O3 forbids — and worse,
 * the self-host guard downstream would then match against an invented target.
 */
function hostDependenciesFrom(runtime: Observed<RuntimeSource>, extra: readonly HostDependency[]): HostDependency[] {
  const api: HostDependency[] =
    runtime.apiPid === undefined && runtime.apiPort === undefined
      ? []
      : [
          {
            kind: 'api',
            ...(runtime.apiPid === undefined ? {} : { pid: runtime.apiPid }),
            ...(runtime.apiPort === undefined ? {} : { port: runtime.apiPort }),
            identityRef: runtime.sourceRef,
          },
        ];
  return [...api, ...extra];
}

export async function buildSelfFacet(deps: SelfFacetDeps): Promise<HomeStateSelfFacet> {
  const now = deps.now?.() ?? Date.now();

  const installation = await deps.installation();
  const runtime = await deps.runtimeStatus();
  const platform = await (deps.platform ?? defaultPlatform)();
  const extraDependencies = (await deps.hostDependencies?.()) ?? [];
  // No reader wired is not "holds nothing". Only an owner that actually
  // answered may produce a list, empty or otherwise.
  const heldLeases = deps.heldLeases ? await deps.heldLeases() : 'unknown';

  return {
    v: 1,
    installation: {
      projectRoot: installation.projectRoot,
      ...(installation.deploymentId === undefined ? {} : { deploymentId: installation.deploymentId }),
      ...freshnessOf(installation, now),
    },
    runtime: {
      worktree: runtime.worktree,
      head: runtime.head,
      ...(runtime.apiPid === undefined ? {} : { apiPid: runtime.apiPid }),
      ...(runtime.apiPort === undefined ? {} : { apiPort: runtime.apiPort }),
      ...freshnessOf(runtime, now),
    },
    platform: {
      os: platform.os,
      arch: platform.arch,
      hostNodeId: platform.hostNodeId,
      ...freshnessOf(platform, now),
    },
    coordinates: {
      ...(deps.invocation.threadId === undefined ? {} : { threadId: deps.invocation.threadId }),
      ...(deps.invocation.invocationId === undefined ? {} : { invocationId: deps.invocation.invocationId }),
      catId: deps.invocation.catId,
    },
    hostDependencies: hostDependenciesFrom(runtime, extraDependencies),
    heldLeases,
    quota: await resolveQuota(deps, now),
  };
}
