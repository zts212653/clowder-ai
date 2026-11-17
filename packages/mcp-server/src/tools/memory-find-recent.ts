import { deploymentDefaults, type ReadRef } from '@cat-cafe/shared';
import { invocationFetch, resolveInvocationEnv } from './invocation-auth.js';
import { cappedLimit, type FindContext } from './memory-find-context.js';
import {
  type Candidate,
  ERROR_TEXT_CAP,
  type FindGroup,
  type GroupOutcome,
  type GroupPlan,
} from './memory-find-group.js';

/**
 * F332 find unification — the recent group (formerly the list_recent tool): with no query, the original recent index
 * browses by time window (since, default 7d), scope ∩ kinds, or task trajectories. Items are ordered by time, not
 * relevance; visibility stays server-derived (KD-8): no collection parameters.
 */

export const RECENT_SCOPES = ['docs', 'threads', 'memory', 'all', 'trajectories'] as const;
const DEFAULT_WINDOW = '7d';

interface RecentItem {
  readRef?: ReadRef;
  anchor: string;
  title: string;
  kind: string;
  updatedAt: string;
  source: string;
  filesRead?: number;
  filesModified?: number;
  verified?: boolean;
  suggestedAction?: { type: string; threadId?: string; reason?: string; source?: string };
}
interface RecentResponse {
  items: RecentItem[];
  groups?: Array<{ key: string; type: 'collection'; label: string; count: number; available: number }>;
  nudge?: string;
}

export interface RecentRun {
  scope?: string;
  since?: string;
  kinds?: readonly string[];
  limit?: number;
  limitNote?: string;
}

export function planRecent(context: FindContext): GroupPlan<RecentRun> {
  if (context.watcher) return { kind: 'skip' };
  if (context.mode === 'query') return { kind: 'skip' };
  if (context.mode === 'continue' && context.continueGroup !== 'recent') return { kind: 'skip' };
  const notCovered = (reason: string, detail: string) => ({ kind: 'not_covered' as const, reason, detail });
  if (context.scope === 'sessions')
    return notCovered(
      'scope_unsupported',
      'The recent index browses docs, threads, memory or trajectories, not sessions.',
    );
  if (context.dimension)
    return notCovered(
      'collection_scope_unsupported',
      'Recent visibility is server-derived; an explicit dimension cannot be applied.',
    );
  if (context.threadId)
    return notCovered('thread_filter_unsupported', 'The recent index cannot restrict items to one thread.');
  if (context.dateTo)
    return notCovered('upper_time_bound_unsupported', 'The recent index has only a lower time bound (since).');
  const capped = cappedLimit('recent', context.limit);
  const since = context.since ?? context.dateFrom;
  return {
    kind: 'run',
    run: {
      ...(context.scope ? { scope: context.scope } : {}),
      ...(since ? { since } : {}),
      ...(context.kinds?.length ? { kinds: context.kinds } : {}),
      ...(capped.limit !== undefined ? { limit: capped.limit } : {}),
      ...(capped.note ? { limitNote: capped.note } : {}),
    },
  };
}

async function fetchRecent(run: RecentRun, signal: AbortSignal): Promise<GroupOutcome<RecentResponse>> {
  const params = new URLSearchParams();
  if (run.scope) params.set('scope', run.scope);
  if (run.since) params.set('since', run.since);
  if (run.limit !== undefined) params.set('limit', String(run.limit));
  if (run.kinds?.length) params.set('kinds', run.kinds.join(','));
  const currentThreadId = resolveInvocationEnv('CAT_CAFE_THREAD_ID')?.trim();
  if (currentThreadId) params.set('currentThreadId', currentThreadId);
  const base = resolveInvocationEnv('CAT_CAFE_API_URL') ?? deploymentDefaults.apiBaseUrl;
  const qs = params.toString();
  const response = await invocationFetch(`${base}/api/library/recent${qs ? `?${qs}` : ''}`, { signal });
  if (signal.aborted) return { status: 'timeout' };
  if (!response.ok)
    return {
      status: 'failed',
      error: `recent browse failed (${response.status}): ${(await response.text()).slice(0, ERROR_TEXT_CAP)}`,
    };
  const data = (await response.json()) as RecentResponse;
  return { status: data.items.length > 0 ? 'ok' : 'no_results', data };
}

type Projection = 'full' | 'compact' | 'minimal';

function itemView(item: RecentItem, projection: Projection): Record<string, unknown> {
  const readRef = item.readRef ? { readRef: item.readRef } : {};
  if (projection === 'minimal') return { anchor: item.anchor, updatedAt: item.updatedAt.slice(0, 10), ...readRef };
  const crossPost =
    item.suggestedAction?.type === 'cross_post' && item.suggestedAction.threadId
      ? { crossPostThreadId: item.suggestedAction.threadId }
      : {};
  if (projection === 'compact')
    return {
      anchor: item.anchor,
      title: item.title,
      kind: item.kind,
      updatedAt: item.updatedAt,
      ...crossPost,
      ...readRef,
    };
  return { ...item, ...readRef };
}

function range(run: RecentRun, data: RecentResponse) {
  return {
    window: run.since ?? `${DEFAULT_WINDOW} (default)`,
    ...(run.scope ? { scope: run.scope } : {}),
    ...(run.kinds?.length ? { kinds: run.kinds } : {}),
    order: 'updatedAt, newest first; not a relevance ranking',
    timestamps: 'docs/memory: source file mtime; trajectories: trajectory updatedAt',
    ...(data.groups && data.groups.length > 1
      ? { collections: data.groups.map((group) => `${group.label} ${group.count}/${group.available}`) }
      : {}),
  };
}

export function createRecentGroup(context: FindContext): FindGroup<RecentResponse> {
  const plan = planRecent(context);
  const run = plan.kind === 'run' ? plan.run : undefined;
  return {
    name: 'recent',
    plan,
    start: (signal) => (run ? fetchRecent(run, signal) : Promise.resolve({ status: 'timeout' })),
    counts: (data) => ({ count: data.items.length, hasNext: false }),
    emptyDetail: (data) => ({
      ...(run ? { range: range(run, data) } : {}),
      ...(data.nudge ? { nudge: data.nudge } : {}),
    }),
    continueArguments: () => ({
      continueGroup: 'recent',
      ...(run?.scope ? { scope: run.scope } : {}),
      ...(run?.since ? { since: run.since } : {}),
      ...(run?.kinds?.length ? { kinds: run.kinds } : {}),
      ...(run?.limit !== undefined ? { limit: run.limit } : {}),
    }),
    pages: (outcome) =>
      run
        ? (['full', 'compact', 'minimal'] as const).map((projection): Candidate => {
            const crossPost = outcome.data.items.some((item) => item.suggestedAction?.type === 'cross_post');
            return {
              status: outcome.status,
              text: JSON.stringify({
                group: 'recent',
                status: outcome.status,
                ...(projection !== 'full' ? { projection } : {}),
                range: range(run, outcome.data),
                ...(run.limitNote ? { limitNote: run.limitNote } : {}),
                ...(outcome.data.nudge ? { nudge: outcome.data.nudge } : {}),
                items: outcome.data.items.map((item) => itemView(item, projection)),
                ...(crossPost
                  ? {
                      tip: 'Items from another thread: send findings there with cat_cafe_cross_post_message (targetCats or a line-start @mention).',
                    }
                  : {}),
              }),
            };
          })
        : [],
  };
}
