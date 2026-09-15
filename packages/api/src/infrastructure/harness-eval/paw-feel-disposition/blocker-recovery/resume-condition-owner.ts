import { ownerTruthRefV1Schema, type PawFeelResumeSelectorV1 } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../../domains/cats/services/stores/ports/TaskStore.js';
import type { PawFeelResumeConditionResolver, PawFeelResumeResolverSnapshot } from './resume-condition.js';

export interface PawFeelOwnerEventConditionResolver {
  resolve(selector: Extract<PawFeelResumeSelectorV1, { kind: 'owner_event' }>): Promise<PawFeelResumeResolverSnapshot>;
}

export class PawFeelCanonicalResumeConditionResolver implements PawFeelResumeConditionResolver {
  constructor(
    private readonly taskStore: Pick<ITaskStore, 'get'>,
    private readonly ownerEventResolver?: PawFeelOwnerEventConditionResolver,
  ) {}

  async resolve(selector: PawFeelResumeSelectorV1): Promise<PawFeelResumeResolverSnapshot> {
    if (selector.kind === 'bounded_time') {
      return {
        normalizedSelector: selector,
        state: 'waiting',
        version: `bounded:${selector.recheckAt}`,
        satisfied: false,
        evidenceRefs: [],
      };
    }
    if (selector.kind === 'owner_event') {
      if (!this.ownerEventResolver) throw new Error('owner-event condition provider is unavailable');
      return this.ownerEventResolver.resolve(selector);
    }
    const match = /^task:item:([^\s]+)$/u.exec(selector.ref.ownerStateRef);
    if (selector.ref.ownerFeatureId !== 'F310' || !match?.[1]) {
      throw new Error('task resume selector must be an exact F310 task:item ref');
    }
    const task = await this.taskStore.get(match[1]);
    if (!task) throw new Error('task resume selector is unavailable');
    const evidenceRef = ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F310',
      ownerStateRef: `task:item:${task.id}`,
      version: String(task.updatedAt),
    });
    return {
      normalizedSelector: {
        kind: 'task',
        ref: { ownerFeatureId: 'F310', ownerStateRef: `task:item:${task.id}` },
      },
      state: task.status,
      version: JSON.stringify([task.updatedAt, task.status, task.ownerCatId, task.threadId]),
      satisfied: task.status === 'done',
      evidenceRefs: [evidenceRef],
    };
  }
}
