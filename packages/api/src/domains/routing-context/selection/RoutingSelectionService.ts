import type { RoutingContextReadService, RoutingSnapshotReadModel } from '../RoutingContextReadService.js';
import { routingSelectionFacts } from './RoutingSelectionFacts.js';

export type RoutingSelectionRole = 'review' | 'architecture' | 'implementation';

/** Role is caller-owned intent. Existing profiles do not grant machine-readable role eligibility. */
export class RoutingSelectionService {
  constructor(
    private readonly deps: { readService: Pick<RoutingContextReadService, 'readSnapshot'>; now?: () => number },
  ) {}

  async read(input: { ownerId: string; role: RoutingSelectionRole; targetCatIds: readonly string[] }) {
    const base = { stage: 'selection' as const, role: input.role, roleFit: 'agent_judgment' as const };
    let model: RoutingSnapshotReadModel;
    try {
      model = await this.deps.readService.readSnapshot({
        ownerId: input.ownerId,
        observedAt: this.deps.now?.() ?? Date.now(),
        targetCatIds: input.targetCatIds,
        ...(input.role === 'implementation' ? {} : { intent: input.role }),
      });
    } catch {
      return { ...base, facts: 'unknown: routing source unavailable', missingCatIds: [...input.targetCatIds] };
    }
    const included =
      model.resolution.state === 'fresh'
        ? model.resolution.snapshot.candidates.map((candidate) => candidate.binding.catId)
        : model.resolution.candidateBindings.map((candidate) => candidate.catId);
    return {
      ...base,
      ...(model.resolution.state === 'fresh' ? { snapshotRef: model.resolution.inputRevisionRef } : {}),
      facts: routingSelectionFacts(model),
      missingCatIds: input.targetCatIds.filter((catId) => !included.includes(catId)),
    };
  }
}
