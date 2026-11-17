import type { GroupName } from './memory-find-group.js';

/**
 * F332 find unification — the caller's input, shared by every group's plan. Global narrowing (scope, collection,
 * time, thread, kinds) is kept by each group or reported not_covered; group parameters affect only their own group.
 */
export type FindMode =
  /** Text or an exact anchor: docs, messages, graph and matters. */
  | 'query'
  /** No text: the recent index and the matter directory. */
  | 'browse'
  /** A program-produced continuation reopening one group alone. */
  | 'continue';

export interface FindContext {
  mode: FindMode;
  query?: string;
  limit?: number;
  scope?: string;
  resultUnit?: string;
  dimension?: string;
  threadId?: string;
  dateFrom?: string;
  dateTo?: string;
  since?: string;
  kinds?: readonly string[];
  coverageOffset?: number;
  matterCursor?: string;
  continueGroup?: GroupName;
  /** Resolved inclusive lower time bound (ISO) for groups that filter by an absolute time. */
  lowerBound?: string;
  retrievalMode?: string;
  messageSort?: 'time' | 'relevance';
  agentKeyCatId?: string;
  graphDepth?: number;
  graphRelations?: readonly string[];
  watcher: boolean;
}

/** Per-group maxima of the original routes; a larger shared limit is applied as the maximum and stated. */
export const GROUP_LIMIT_MAX: Readonly<Record<'docs' | GroupName, number>> = {
  docs: 20,
  messages: 20,
  graph: 0,
  matters: 30,
  recent: 100,
};

export function cappedLimit(group: 'docs' | GroupName, limit: number | undefined) {
  if (limit === undefined) return { limit: undefined, note: undefined };
  const max = GROUP_LIMIT_MAX[group];
  if (max === 0 || limit <= max) return { limit: max === 0 ? undefined : limit, note: undefined };
  return { limit: max, note: `${group} returns at most ${max}; limit ${limit} was applied as ${max}` };
}

/** resultUnit and coverage_offset select the original document search alone: no other group ever takes them. */
export function isExplicitDocsOnly(context: FindContext): boolean {
  return Boolean(context.resultUnit) || context.coverageOffset != null;
}
