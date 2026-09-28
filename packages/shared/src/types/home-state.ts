/**
 * F300 Home-State — terminal contract for what a cat knows about itself.
 *
 * Everything here is refs-only: the facet points at owner facts, it never
 * copies their typed payload and it is never persisted. A snapshot is built on
 * demand and thrown away (KD-12/14), so there is no cache to invalidate and no
 * second source of truth to drift.
 *
 * Missing evidence is expressed with `TypedAbsent`, never with a fabricated
 * value and never with a bare boolean (spec AC-O3, AC-1.5).
 */

/**
 * Structurally `NodeJS.Platform`, restated locally: @cat-cafe/shared is bundled
 * into the web app, so it must not pull Node type globals in.
 */
export type HostPlatform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32';

/** Where an observation came from and how long it may be trusted. */
export interface Freshness {
  readonly observedAt: number;
  readonly expiresAt?: number;
  /** Must resolve back to the owner's canonical truth; a projection is not a source. */
  readonly sourceRef: string;
}

/**
 * Why a fact is missing. These stay distinguishable end to end: an unreachable
 * owner is a different operational situation from an unauthorized read, and
 * neither may be softened into "fine to proceed".
 */
export type TypedAbsent = 'unknown' | 'stale' | 'conflict' | 'not_authorized' | 'owner_unreachable';

/** A process or service this cat is running inside of, or depends on to keep running. */
export interface HostDependency {
  readonly kind: 'api' | 'redis' | 'cli' | 'daemon';
  readonly pid?: number;
  readonly port?: number;
  /** Ref to the owner record proving this identity (e.g. the daemon state file). */
  readonly identityRef: string;
}

/** An owner-typed view of the quota pool this cat draws from. */
export type QuotaFacet =
  | ({ readonly status: 'ok' | 'low' | 'exhausted'; readonly poolRef: string } & Freshness)
  | TypedAbsent;

/**
 * Which thing a revision is the revision *of*.
 *
 * `running` is the revision the live process recorded when it started, and is
 * the only one that answers "what is executing right now". `checkout` is the
 * revision on disk, which changes the moment somebody syncs the source and
 * therefore proves nothing about the running instance. Collapsing the two —
 * or returning an empty string when neither can be read — is what let a synced
 * but un-restarted deployment look up to date.
 */
export type RevisionSource = 'running' | 'checkout';

export type RuntimeRevision = { readonly revision: string; readonly source: RevisionSource } | TypedAbsent;

/**
 * "Where am I, what am I running inside of, and what am I currently holding."
 *
 * `v` is the contract version. Fields are additive only — this is the terminal
 * shape, not a first cut to be rewritten later.
 */
export interface HomeStateSelfFacet {
  readonly v: 1;
  readonly installation: { readonly projectRoot: string; readonly deploymentId?: string } & Freshness;
  readonly runtime: {
    readonly worktree: string;
    readonly head: RuntimeRevision;
    readonly apiPid?: number;
    readonly apiPort?: number;
  } & Freshness;
  readonly platform: { readonly os: HostPlatform; readonly arch: string; readonly hostNodeId: string } & Freshness;
  readonly coordinates: { readonly threadId?: string; readonly invocationId?: string; readonly catId: string };
  readonly hostDependencies: readonly HostDependency[];
  /**
   * F167 lease refs, refs only — the lease itself stays with its owner.
   *
   * `TypedAbsent` when no reader is wired or the owner could not be reached.
   * An empty array is a real answer ("this cat holds nothing"), and the two
   * must not be spelled the same way: an unread source that renders as `[]`
   * tells the cat it is holding nothing when nobody actually looked.
   */
  readonly heldLeases: readonly string[] | TypedAbsent;
  readonly quota: QuotaFacet;
}

/**
 * What a proposed side effect would touch, and whether any of it is us.
 *
 * `unknown` is a refusal, not a shrug: an unresolvable destructive target fails
 * closed, because "I could not tell" and "it is safe" are different answers.
 */
export type SideEffectVerdict = 'allow' | 'self_host' | 'sanctuary' | 'unknown';

export interface SideEffectAssessment {
  readonly verdict: SideEffectVerdict;
  /** Plain language, and — when we refuse — where to go instead. */
  readonly reason: string;
  /** identityRefs of the host/sanctuary targets that matched. */
  readonly matchedTargets: readonly string[];
  readonly sourceRefs: readonly string[];
}
