import {
  type DevelopmentScopeQueryV1,
  type DevelopmentScopeV1,
  developmentPhaseKeyPattern,
  developmentScopeQueryV1Schema,
  developmentScopeV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import {
  type DevelopmentWorkActor,
  developmentTaskSnapshot,
  developmentWorkIsOpen,
} from '../cats/services/stores/ports/DevelopmentWorkTransition.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';

export class DevelopmentScopeUnavailable extends Error {}

export interface DevelopmentScopeDocuments {
  readFeature(featureId: string, revision: string): Promise<{ ref: string; content: string } | null>;
  readPlan(ref: string, revision: string): Promise<string | null>;
}
export type DevelopmentScopeResolution =
  | {
      result: 'resolved';
      scope: DevelopmentScopeV1;
      existing?: {
        taskRef: string;
        snapshot: string;
        revision?: number;
        disposition: 'resume' | 'bind' | 'adopt';
      };
    }
  | { result: 'scope_unverifiable'; retryable: true }
  | { result: 'scope_invalid' | 'scope_unavailable_here' | 'scope_ambiguous' | 'scope_closed' | 'forbidden' };

function declaredPhases(content: string): string[] {
  // The complete key identifies responsibility; title wording and heading depth do not.
  const withoutFences = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  return [
    ...new Set(
      [
        ...withoutFences.matchAll(
          new RegExp(`^#{1,6}[ \\t]+Phase[ \\t]+(${developmentPhaseKeyPattern})(?=[ \\t:：（(—–✅]|$).*$`, 'gm'),
        ),
      ].flatMap((match) => (match[1] ? [match[1]] : [])),
    ),
  ];
}
function hasPlanAnchor(content: string, anchor: string): boolean {
  const declarations = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const explicit = declarations.match(new RegExp(`(?:id=["']${escaped}["']|\\{#${escaped}\\})`, 'g')) ?? [];
  const headings = [...declarations.matchAll(/^#{1,6}[ \t]+(.+)$/gm)].map((m) =>
    (m[1] ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-'),
  );
  return explicit.length === 1 || (explicit.length === 0 && headings.filter((value) => value === anchor).length === 1);
}

type ScopeFailure = Exclude<DevelopmentScopeResolution, { result: 'resolved' }>;

function finishResolution(
  actor: DevelopmentWorkActor,
  scope: DevelopmentScopeV1,
  matches: readonly TaskItem[],
  explicitTask: TaskItem | null,
): DevelopmentScopeResolution {
  if (matches.some((task) => task.threadId !== actor.threadId)) return { result: 'scope_unavailable_here' };
  if (matches.some((task) => task.ownerCatId !== actor.catId)) return { result: 'forbidden' };
  if (matches.some((task) => !developmentWorkIsOpen(task))) return { result: 'scope_closed' };
  if (matches.length > 1 || (explicitTask && matches[0] && matches[0].id !== explicitTask.id))
    return { result: 'scope_ambiguous' };
  const task = explicitTask ?? matches[0];
  if (!task) return { result: 'resolved', scope };
  return {
    result: 'resolved',
    scope,
    existing: {
      taskRef: `task:work:${task.id}`,
      snapshot: developmentTaskSnapshot(task),
      ...(task.entrustedWork ? { revision: task.entrustedWork.revision } : {}),
      disposition: task.entrustedWork?.developmentScope ? 'resume' : task.entrustedWork ? 'bind' : 'adopt',
    },
  };
}

/** Task-owned resolution. Only this boundary converts Feature/plan identity into a work scope. */
export class DevelopmentScopeResolver {
  constructor(
    private readonly tasks: ITaskStore,
    private readonly docs: DevelopmentScopeDocuments,
  ) {}

  private async selectWorkUnit(
    actor: DevelopmentWorkActor,
    query: DevelopmentScopeQueryV1,
  ): Promise<{ workUnitRef?: string } | ScopeFailure> {
    if (query.workUnitRef) return { workUnitRef: query.workUnitRef };
    const children = (await this.tasks.listByThread(actor.threadId)).filter((task) => {
      const scope = task.entrustedWork?.developmentScope;
      return (
        task.userId === actor.userId &&
        task.ownerCatId === actor.catId &&
        developmentWorkIsOpen(task) &&
        scope?.featureRef === query.featureRef &&
        scope.phaseKey === query.phaseKey &&
        !scope.workUnitRef.startsWith('feature-phase:')
      );
    });
    if (children.length > 1) return { result: 'scope_ambiguous' };
    const child = children[0];
    return { workUnitRef: child?.entrustedWork?.developmentScope?.workUnitRef };
  }

  private async resolveTask(
    actor: DevelopmentWorkActor,
    query: DevelopmentScopeQueryV1,
    ref: string,
  ): Promise<TaskItem | ScopeFailure> {
    const task = await this.tasks.get(ref.slice('task:work:'.length));
    if (!task || task.userId !== actor.userId) return { result: 'forbidden' };
    if (task.threadId !== actor.threadId) return { result: 'scope_unavailable_here' };
    if (task.ownerCatId !== actor.catId) return { result: 'forbidden' };
    if (!developmentWorkIsOpen(task)) return { result: 'scope_closed' };
    const bound = task.entrustedWork?.developmentScope;
    if (
      bound &&
      (bound.featureRef !== query.featureRef || bound.phaseKey !== query.phaseKey || bound.workUnitRef !== ref)
    )
      return { result: 'scope_invalid' };
    return task;
  }

  async resolve(actor: DevelopmentWorkActor, input: DevelopmentScopeQueryV1): Promise<DevelopmentScopeResolution> {
    const query = developmentScopeQueryV1Schema.parse(input);
    const featureId = query.featureRef.slice('feature:'.length);
    try {
      return await this.resolveDocuments(actor, query, featureId);
    } catch (error) {
      if (error instanceof DevelopmentScopeUnavailable) return { result: 'scope_unverifiable', retryable: true };
      throw error;
    }
  }

  private async resolveDocuments(
    actor: DevelopmentWorkActor,
    query: DevelopmentScopeQueryV1,
    featureId: string,
  ): Promise<DevelopmentScopeResolution> {
    const feature = await this.docs.readFeature(featureId, query.acceptedRevision);
    if (!feature || !declaredPhases(feature.content).includes(query.phaseKey)) return { result: 'scope_invalid' };
    const selected = await this.selectWorkUnit(actor, query);
    if ('result' in selected) return selected;
    const { workUnitRef } = selected;
    let explicitTask: TaskItem | null = null;
    let acceptedSourceRef = feature.ref;
    if (workUnitRef?.startsWith('task:work:')) {
      const task = await this.resolveTask(actor, query, workUnitRef);
      if ('result' in task) return task;
      explicitTask = task;
    } else if (workUnitRef?.startsWith('file:')) {
      const plan = await this.docs.readPlan(workUnitRef, query.acceptedRevision),
        anchor = workUnitRef.split('#')[1];
      if (!plan || !anchor || !hasPlanAnchor(plan, anchor)) return { result: 'scope_invalid' };
      acceptedSourceRef = workUnitRef;
    }
    const scope = developmentScopeV1Schema.parse({
      ...query,
      acceptedSourceRef,
      workUnitRef: workUnitRef ?? `feature-phase:${featureId}:${query.phaseKey}`,
    });
    return finishResolution(actor, scope, await this.tasks.findDevelopmentWork(actor.userId, scope), explicitTask);
  }
}
