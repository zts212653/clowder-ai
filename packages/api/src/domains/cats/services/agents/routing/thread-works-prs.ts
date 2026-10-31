import { parsePullRequestFullRef, type TaskItem } from '@cat-cafe/shared';
import type { AggregatorPrTask } from './thread-artifacts-aggregator.js';

function formalPr(ref: string): string | null {
  const direct = parsePullRequestFullRef(ref.startsWith('pr:') ? ref.slice(3) : ref);
  if (direct) return `${direct.repoFullName}#${direct.prNumber}`;
  try {
    const url = new URL(ref);
    if (url.origin !== 'https://github.com' || url.search || url.hash) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    const target = match && parsePullRequestFullRef(`${match[1]}/${match[2]}#${match[3]}`);
    return target ? `${target.repoFullName}#${target.prNumber}` : null;
  } catch {
    return null;
  }
}

/** Formal Task attachment is delivery; titles and prose are never artifact coordinates. */
export function threadWorksPrs(tasks: TaskItem[], userId: string, threadOwner: string): AggregatorPrTask[] {
  return tasks.flatMap((task) => {
    const visible = task.userId === userId || (task.kind === 'work' && !task.userId && threadOwner === userId);
    if (!visible || (task.kind !== 'work' && task.kind !== 'pr_tracking')) return [];
    const refs = [task.subjectKey, ...(task.kind === 'work' ? (task.entrustedWork?.artifactRefs ?? []) : [])];
    return refs.flatMap((ref) => {
      const pr = ref ? formalPr(ref) : null;
      return pr ? [{ ...task, subjectKey: `pr:${pr}` }] : [];
    });
  });
}
