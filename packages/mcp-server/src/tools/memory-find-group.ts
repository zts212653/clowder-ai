/**
 * F332 find unification — shared shape of a find group beside the docs group.
 * A group forwards the caller's input to one original owner route, reports its own status, range and complete
 * continuation, and renders a ladder from its richest form to its smallest honest form. Nothing is stored.
 */

export type GroupName = 'messages' | 'graph' | 'matters' | 'recent';

export const ERROR_TEXT_CAP = 300;

export type GroupPlan<R> =
  | { kind: 'run'; run: R }
  | { kind: 'not_covered'; reason: string; detail: string }
  /** Outside the caller's explicit range, or not a qualification of this identity: no status at all. */
  | { kind: 'skip' };

/**
 * Why an unfinished group stopped: the ceiling shared with the other groups, or the caller (its cancellation or its
 * own time limit). Each stop source records its own cause; the first one wins.
 */
export type TimeoutCause = 'deadline' | 'cancelled';

export type GroupOutcome<D> =
  | { status: 'ok' | 'no_results'; data: D }
  | { status: 'failed'; error: string }
  | { status: 'timeout'; cause?: TimeoutCause };

export interface Candidate {
  status: string;
  text: string;
}

export interface GroupRender {
  group: GroupName;
  status: string;
  count: number;
  hasNext: boolean;
  text: string;
}

export interface RenderOptions {
  budgetChars: number;
  /** The only group in this response (its full page may use the whole budget, with descriptions). */
  alone: boolean;
}

/** One group's runnable behaviour; `start` is called once with the shared group signal. */
export interface FindGroup<D = unknown> {
  name: GroupName;
  plan: GroupPlan<unknown>;
  start(signal: AbortSignal): Promise<GroupOutcome<D>>;
  /** Page renderings for a settled ok/no_results outcome, richest first (statuses are added generically). */
  pages(outcome: { status: 'ok' | 'no_results'; data: D }, options: RenderOptions): Candidate[];
  /** Arguments that reopen this group alone, unchanged by the caller. */
  continueArguments(): Record<string, unknown>;
  counts(data: D): { count: number; hasNext: boolean };
  /** Status-only rich fields for an empty result (e.g. the match rule). */
  emptyDetail?(data: D): Record<string, unknown>;
}

export function statusPair(group: GroupName, status: string, rich: Record<string, unknown>): Candidate[] {
  return [
    { status, text: JSON.stringify({ group, status, ...rich }) },
    { status, text: JSON.stringify({ group, status }) },
  ];
}

/**
 * Groups are not cut when docs settle; they share one wait budget so that a slow group cannot hold the whole response
 * (plan: a shared deadline, unfinished groups reported on their own). It bounds how long the find waits for a group, not
 * the whole call. Plan owner's ruling thread_mwixqbezq81zubdw#0001794918820465-001068-e0cb853b: only a group that really
 * outlasts it reports timeout with its complete next, and that continuation still counts in the journey. 16s is a
 * candidate budget (see find-entry.md).
 */
const GROUP_DEADLINE_SECONDS = 16;
const REOPEN_ALONE =
  'Pass next.arguments unchanged to reopen this group alone: alone it is not cut by the shared wait budget and waits until its route answers or the caller stops it.';
const TIMEOUT_DETAIL: Readonly<Record<TimeoutCause, string>> = {
  deadline: `No answer within the ${GROUP_DEADLINE_SECONDS}s wait budget shared with the other groups; not a no-results claim. ${REOPEN_ALONE}`,
  cancelled:
    'Stopped because the caller cancelled this call or its own time limit ended; not a no-results claim. Pass next.arguments unchanged to retry this group.',
};

function unfinishedPair(
  group: GroupName,
  status: 'timeout' | 'failed',
  next: { tool: string; arguments: Record<string, unknown> },
  rich: Record<string, unknown>,
): Candidate[] {
  const { detail: _detail, error: _error, ...brief } = rich;
  return [
    { status, text: JSON.stringify({ group, status, ...rich, next }) },
    { status, text: JSON.stringify({ group, status, ...brief, next }) },
  ];
}

/** The full ladder of a group for one outcome; the last element is its smallest honest form. */
export function groupLadder<D>(
  group: FindGroup<D>,
  outcome: GroupOutcome<D> | undefined,
  options: RenderOptions,
): Candidate[] {
  const { plan, name } = group;
  if (plan.kind === 'skip') return [];
  if (plan.kind === 'not_covered')
    return [
      {
        status: 'not_covered',
        text: JSON.stringify({ group: name, status: 'not_covered', reason: plan.reason, detail: plan.detail }),
      },
      { status: 'not_covered', text: JSON.stringify({ group: name, status: 'not_covered', reason: plan.reason }) },
    ];
  // An unfinished group keeps a way back in every rendering: the arguments that reopen it alone.
  const next = { tool: 'cat_cafe_search_evidence', arguments: group.continueArguments() };
  if (!outcome || outcome.status === 'timeout') {
    const cause = outcome?.cause ?? 'deadline';
    return unfinishedPair(name, 'timeout', next, {
      cause,
      detail: TIMEOUT_DETAIL[cause],
    });
  }
  if (outcome.status === 'failed') return unfinishedPair(name, 'failed', next, { error: outcome.error });
  const { count, hasNext } = group.counts(outcome.data);
  if (count === 0 && !hasNext) return statusPair(name, outcome.status, group.emptyDetail?.(outcome.data) ?? {});
  const deferred = {
    pages: count,
    hasMore: hasNext,
    next: { tool: 'cat_cafe_search_evidence', arguments: group.continueArguments() },
  };
  return [
    ...group.pages(outcome, options),
    {
      status: 'deferred',
      text: JSON.stringify({ group: name, status: 'deferred', reason: 'response_budget', ...deferred }),
    },
    { status: 'deferred', text: JSON.stringify({ group: name, status: 'deferred', ...deferred }) },
  ];
}

export function pickRendering<D>(
  group: FindGroup<D>,
  outcome: GroupOutcome<D> | undefined,
  options: RenderOptions,
): GroupRender {
  const ladder = groupLadder(group, outcome, options);
  const chosen = ladder.find((candidate) => candidate.text.length <= options.budgetChars) ?? ladder[ladder.length - 1];
  if (!chosen) throw new Error(`Find group ${group.name} has no rendering`);
  const page =
    outcome && (outcome.status === 'ok' || outcome.status === 'no_results')
      ? group.counts(outcome.data)
      : { count: 0, hasNext: false };
  return { group: group.name, status: chosen.status, ...page, text: chosen.text };
}

/** A group beside others is bounded by the shared ceiling; a group reopened alone only by its route and the caller. */
const GROUP_DEADLINE_MS = GROUP_DEADLINE_SECONDS * 1_000;

/** Owns one group's shared deadline and its isolated rendering. */
export class GroupRun<D = unknown> {
  private readonly controller = new AbortController();
  private readonly deadline: ReturnType<typeof setTimeout> | undefined;
  private readonly outcome: Promise<GroupOutcome<D> | undefined>;
  private cause: TimeoutCause | undefined;
  /** The first stop source records its cause; later ones find the run already stopped. */
  private stop(cause: TimeoutCause): void {
    if (this.controller.signal.aborted) return;
    this.cause = cause;
    this.controller.abort();
  }
  private readonly stopAtDeadline = () => this.stop('deadline');
  private readonly stopByCaller = () => this.stop('cancelled');

  /**
   * The shared ceiling only keeps a slow group from holding the others. A group reopened alone (a continuation) has no
   * other group to hold: like the original tool, it waits until its route answers or the caller's signal stops it.
   */
  constructor(
    readonly group: FindGroup<D>,
    private readonly signal?: AbortSignal,
    options: { alone?: boolean } = {},
  ) {
    this.deadline = options.alone ? undefined : setTimeout(this.stopAtDeadline, GROUP_DEADLINE_MS);
    if (signal?.aborted) this.stopByCaller();
    else signal?.addEventListener('abort', this.stopByCaller, { once: true });
    this.outcome =
      group.plan.kind === 'run'
        ? group
            .start(this.controller.signal)
            // A group that maps its own abort to `timeout` still gets the reason this run stopped it.
            .then((outcome) =>
              outcome.status === 'timeout' && !outcome.cause && this.controller.signal.aborted
                ? { status: 'timeout' as const, ...(this.cause ? { cause: this.cause } : {}) }
                : outcome,
            )
            .catch((error: unknown) =>
              this.controller.signal.aborted
                ? ({ status: 'timeout', ...(this.cause ? { cause: this.cause } : {}) } as const)
                : ({
                    status: 'failed',
                    error: String(error instanceof Error ? error.message : error).slice(0, ERROR_TEXT_CAP),
                  } as const),
            )
        : Promise.resolve(undefined);
  }

  async minimalChars(): Promise<number> {
    const ladder = this.safeLadder(await this.outcome, { budgetChars: 0, alone: false });
    return ladder[ladder.length - 1]?.text.length ?? 0;
  }

  // One group's projection failure is that group's failure; it never takes the other groups down.
  async render(options: RenderOptions): Promise<GroupRender> {
    const outcome = await this.outcome;
    try {
      return pickRendering(this.group, outcome, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return pickRendering(
        this.group,
        { status: 'failed', error: `projection failed: ${message}`.slice(0, ERROR_TEXT_CAP) },
        options,
      );
    }
  }

  private safeLadder(outcome: GroupOutcome<D> | undefined, options: RenderOptions): Candidate[] {
    try {
      return groupLadder(this.group, outcome, options);
    } catch {
      return groupLadder(this.group, { status: 'failed', error: '' }, options);
    }
  }

  close(): void {
    clearTimeout(this.deadline);
    this.signal?.removeEventListener('abort', this.stopByCaller);
  }
}
