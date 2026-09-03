import { type GitHubPrWaitPredicate, PR_TRACKING_EVENT_NAMES, type PrTrackingEventName } from '@cat-cafe/shared';

/**
 * #1392: user-facing PR-tracking event names → wait predicates.
 *
 * The simplified `register_pr_tracking(repoFullName, prNumber)` interface
 * materializes the default subscription set server-side; callers adjust it by
 * event NAME (not predicate kind) via include/exclude.
 *
 * #1394: the NAME vocabulary itself lives in @cat-cafe/shared so the MCP tool and
 * this route cannot advertise different words.
 */

/**
 * F280 section 2.4b: whether an event is armed by default can depend on WHO registered.
 *
 * `'author'` means "on only when the registrant is the PR author". It is still one
 * vocabulary and one include/exclude list — the role picks a default, it does not add a
 * second axis the caller has to reason about.
 */
type PrTrackingEventDefault = boolean | 'author';

interface PrTrackingEventSpec {
  readonly predicate: GitHubPrWaitPredicate;
  readonly default: PrTrackingEventDefault;
}

/** Ordered catalog. Insertion order = deterministic predicate output order. */
export const PR_TRACKING_EVENT_CATALOG: Readonly<Record<PrTrackingEventName, PrTrackingEventSpec>> = {
  review_decision: { predicate: { kind: 'pr_review_decision_changed' }, default: true },
  conversation_comment: { predicate: { kind: 'pr_conversation_comment_added' }, default: true },
  inline_comment: { predicate: { kind: 'pr_inline_comment_added' }, default: true },
  // The author is waiting on the bot round; a maintainer only wants the author's own
  // replies and would be spammed by someone else's back-and-forth with a bot.
  bot_interaction: { predicate: { kind: 'pr_bot_interaction' }, default: 'author' },
  ci_terminal: { predicate: { kind: 'pr_ci_terminal' }, default: true },
  conflict: { predicate: { kind: 'pr_became_conflicting' }, default: true },
  base_behind: { predicate: { kind: 'pr_base_behind' }, default: true },
  head_changed: { predicate: { kind: 'pr_head_changed' }, default: false },
};

export function isPrTrackingEventName(name: string): name is PrTrackingEventName {
  return Object.hasOwn(PR_TRACKING_EVENT_CATALOG, name);
}

export interface BuildPrTrackingPredicatesInput {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /**
   * F280 section 2.4b: `false` ONLY when the registrant is positively known not to be the
   * PR author. Undefined (role unresolvable — e.g. the GitHub identity is unavailable)
   * arms role-defaulted events, because A26 says muting a real signal is the worse failure:
   * extra noise is visible and recoverable, silence is neither.
   */
  readonly registrantIsPrAuthor?: boolean;
}

/**
 * Validate include/exclude names WITHOUT needing the role. Lets a route reject a typo with
 * 400 before it spends a GitHub round-trip resolving who the registrant is.
 */
export function assertPrTrackingEventNames(input: BuildPrTrackingPredicatesInput = {}): void {
  for (const [field, names] of [
    ['include', input.include ?? []],
    ['exclude', input.exclude ?? []],
  ] as const) {
    for (const raw of names) {
      if (!isPrTrackingEventName(raw)) {
        throw new Error(
          `unknown PR tracking event in ${field}: "${raw}" (valid: ${PR_TRACKING_EVENT_NAMES.join(', ')})`,
        );
      }
    }
  }
}

/**
 * Materialize the #1392 default subscription set, adjusted by include/exclude.
 * Throws on unknown event names — fail loud, never silently drop an event
 * (that silent-no-op path is exactly the #1392 "collected but no notification"
 * failure mode). Output order follows PR_TRACKING_EVENT_CATALOG.
 */
export function buildPrTrackingPredicates(input: BuildPrTrackingPredicatesInput = {}): GitHubPrWaitPredicate[] {
  assertPrTrackingEventNames(input);
  const enabled = new Set<PrTrackingEventName>();
  for (const name of PR_TRACKING_EVENT_NAMES) {
    const fallback = PR_TRACKING_EVENT_CATALOG[name].default;
    if (fallback === 'author' ? input.registrantIsPrAuthor !== false : fallback) enabled.add(name);
  }
  for (const raw of input.include ?? []) {
    if (isPrTrackingEventName(raw)) enabled.add(raw);
  }
  for (const raw of input.exclude ?? []) {
    if (isPrTrackingEventName(raw)) enabled.delete(raw);
  }
  return PR_TRACKING_EVENT_NAMES.filter((name) => enabled.has(name)).map(
    (name) => PR_TRACKING_EVENT_CATALOG[name].predicate,
  );
}
