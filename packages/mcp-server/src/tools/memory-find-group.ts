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

export type GroupOutcome<D> =
  | { status: 'ok' | 'no_results'; data: D }
  | { status: 'failed'; error: string }
  | { status: 'timeout' };

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
  if (!outcome || outcome.status === 'timeout')
    return statusPair(name, 'timeout', {
      detail: 'No answer within the shared find deadline; not a no-results claim. Retry.',
    });
  if (outcome.status === 'failed') return statusPair(name, 'failed', { error: outcome.error });
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

/** A non-docs group may not hold the others: an overall ceiling, and a short grace once docs have settled. */
const GROUP_DEADLINE_MS = 10_000;
const GROUP_GRACE_AFTER_DOCS_MS = 3_000;

/** Owns one group's shared deadline and its isolated rendering. */
export class GroupRun<D = unknown> {
  private readonly controller = new AbortController();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private grace: ReturnType<typeof setTimeout> | undefined;
  private readonly outcome: Promise<GroupOutcome<D> | undefined>;
  private readonly abort = () => this.controller.abort();

  constructor(
    readonly group: FindGroup<D>,
    private readonly signal?: AbortSignal,
  ) {
    this.deadline = setTimeout(this.abort, GROUP_DEADLINE_MS);
    signal?.addEventListener('abort', this.abort, { once: true });
    this.outcome =
      group.plan.kind === 'run'
        ? group.start(this.controller.signal).catch((error: unknown) =>
            this.controller.signal.aborted
              ? ({ status: 'timeout' } as const)
              : ({
                  status: 'failed',
                  error: String(error instanceof Error ? error.message : error).slice(0, ERROR_TEXT_CAP),
                } as const),
          )
        : Promise.resolve(undefined);
  }

  othersSettled(): void {
    this.grace ??= setTimeout(this.abort, GROUP_GRACE_AFTER_DOCS_MS);
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
    if (this.grace) clearTimeout(this.grace);
    this.signal?.removeEventListener('abort', this.abort);
  }
}
