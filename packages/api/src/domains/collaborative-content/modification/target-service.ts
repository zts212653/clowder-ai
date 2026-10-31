import { type ContentModificationRequest, catRegistry, type RoutingPreflightDecisionV1 } from '@cat-cafe/shared';
import { resolveThreadAccess } from '../../cats/services/session/thread-access-policy.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import {
  preflightRoutingDispatch,
  type RoutingDispatchPreflightPort,
  unavailableRoutingDispatchDecision,
} from '../../routing-context/RoutingDispatchPreflightPort.js';
import type { ContentReturnIntent } from '../artifact-review/return-store.js';

export class ModificationTargetError extends Error {
  constructor(
    readonly code: 'target_unavailable' | 'target_denied' | 'thread_unavailable',
    readonly decision?: RoutingPreflightDecisionV1,
  ) {
    super(code);
  }
}

/** The caller's named cat survives warnings. No current/first-cat fallback and no thread creation. */
export class ModificationTargetService {
  constructor(
    private readonly deps: { threads: Pick<IThreadStore, 'get' | 'list'>; routing?: RoutingDispatchPreflightPort },
  ) {}

  async choices(ownerUserId: string) {
    const configs = Object.values(catRegistry.getAllConfigs());
    const decision = await this.preflight(
      ownerUserId,
      configs.map((cat) => cat.id),
    );
    const threads = [];
    for (const thread of await this.deps.threads.list(ownerUserId)) {
      if (thread.deletedAt) continue;
      const access = await resolveThreadAccess({
        threadStore: this.deps.threads,
        thread,
        userId: ownerUserId,
        request: { resource: 'transcript', action: 'read' },
      });
      if (access.status === 200) threads.push({ threadId: thread.id, title: thread.title });
    }
    return {
      cats: configs.map((cat) => ({
        catId: cat.id,
        name: cat.displayName,
        variantLabel: cat.variantLabel,
        mcpSupport: cat.mcpSupport,
        restrictions: cat.restrictions ?? [],
        preflight: decision.targets.find((item) => item.targetCatId === cat.id),
      })),
      threads,
    };
  }

  async authorize(payload: Pick<ContentModificationRequest, 'targetCatId' | 'threadId'>, ownerUserId: string) {
    const config = catRegistry.tryGet(payload.targetCatId)?.config;
    if (!config || !config.mcpSupport) throw new ModificationTargetError('target_unavailable');
    const thread = await this.deps.threads.get(payload.threadId);
    if (!thread || thread.deletedAt) throw new ModificationTargetError('thread_unavailable');
    const access = await resolveThreadAccess({
      threadStore: this.deps.threads,
      thread,
      userId: ownerUserId,
      request: { resource: 'transcript', action: 'read' },
    });
    if (access.status !== 200) throw new ModificationTargetError('thread_unavailable');
    const decision = await this.preflight(ownerUserId, [payload.targetCatId]);
    if (
      decision.targets.some((target) => target.targetCatId === payload.targetCatId && target.disposition === 'rejected')
    )
      throw new ModificationTargetError('target_denied', decision);
    // Same-breed cats share a displayName; the variant label is what tells them apart.
    const targetName = config.variantLabel ? `${config.displayName}（${config.variantLabel}）` : config.displayName;
    return { targetName, threadTitle: thread.title || '未命名对话', preflight: decision };
  }

  async authorizeDelivery(intent: ContentReturnIntent) {
    await this.authorize(intent, intent.ownerUserId);
  }

  private preflight(ownerId: string, targetCatIds: string[]) {
    const input = { ownerId, targetCatIds };
    return this.deps.routing
      ? preflightRoutingDispatch(this.deps.routing, input)
      : Promise.resolve(unavailableRoutingDispatchDecision(input, Date.now(), 'runtime_absent'));
  }
}
