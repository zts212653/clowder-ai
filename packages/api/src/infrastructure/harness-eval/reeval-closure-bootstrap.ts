import type { LifecycleRootArtifact } from './publish-verdict/lifecycle-root-artifact.js';
import { ReevalClosureProjectionError } from './reeval-closure.js';
import type { EvalLifecycleEvent, EvalLifecycleRef } from './reeval-closure-schema.js';

const BOOTSTRAP_ACTOR = { kind: 'automation', id: 'eval-verdict-closure-reconciler' } as const;

export function lifecycleRootRefs(root: LifecycleRootArtifact): EvalLifecycleRef[] {
  return [
    {
      kind: 'verdict',
      availability: 'available',
      value: `docs/harness-feedback/verdicts/${root.verdictId}.md`,
    },
    {
      kind: 'other',
      availability: 'available',
      value: `docs/harness-feedback/bundles/${root.verdictId}/lifecycle-root.json`,
    },
  ];
}

export function buildLifecycleOpenedEvent(
  root: LifecycleRootArtifact,
  refs: readonly EvalLifecycleRef[] = lifecycleRootRefs(root),
): EvalLifecycleEvent {
  return {
    eventId: `f266:${root.verdictId}:opened`,
    verdictId: root.verdictId,
    domainId: root.domainId,
    type: 'verdict_opened',
    actor: BOOTSTRAP_ACTOR,
    occurredAt: root.createdAt,
    reason: 'actionable verdict published with immutable lifecycle root metadata',
    refs: [...refs],
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function assertLifecycleBootstrapPrefix(
  verdictId: string,
  existing: readonly EvalLifecycleEvent[],
  bootstrap: readonly EvalLifecycleEvent[],
): void {
  const prefixLength = Math.min(existing.length, bootstrap.length);
  for (let index = 0; index < prefixLength; index += 1) {
    if (JSON.stringify(canonicalize(existing[index])) !== JSON.stringify(canonicalize(bootstrap[index]))) {
      throw new ReevalClosureProjectionError(
        'invalid_history',
        `lifecycle ${verdictId} diverges from canonical bootstrap at sequence ${index}`,
      );
    }
  }
}
