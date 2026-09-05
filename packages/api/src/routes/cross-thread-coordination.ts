import { randomUUID } from 'node:crypto';
import type { CrossThreadCoordination, CrossThreadCoordinationInput } from '@cat-cafe/shared';

export interface IncomingCrossThreadCoordination {
  sourceThreadId: string;
  coordination: CrossThreadCoordination;
}

export interface ResolvedCrossThreadCoordination {
  coordination?: CrossThreadCoordination;
  /** Terminal ACK is visible/persistent but must not create another invocation. */
  suppressRouting: boolean;
  /** Invalid explicit/incoming terminal identity; callers must reject before persistence or routing. */
  conflict?: CrossThreadCoordinationConflict;
  /** Stable request-provenance key for retries whose persisted id is server-minted. */
  contentDedupCoordinationKey?: 'minted-active-root' | 'minted-terminal-root';
}

export type CrossThreadCoordinationConflict =
  | {
      kind: 'coordination_id_conflict';
      message: string;
      incomingCoordinationId: string;
      explicitCoordinationId: string;
    }
  | {
      kind: 'coordination_subject_conflict';
      message: string;
      coordinationId: string;
      incomingSubjectRef: string;
      explicitSubjectRef: string;
    };

interface ResolveInput {
  explicit?: CrossThreadCoordinationInput;
  incoming?: IncomingCrossThreadCoordination;
  targetThreadId: string;
  mintId?: () => string;
}

function nextHop(incoming: IncomingCrossThreadCoordination | undefined, id: string): number {
  return incoming?.coordination.id === id ? incoming.coordination.hop + 1 : 0;
}

function normalizedSubjectRef(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveExplicitActive(input: ResolveInput, mintId: () => string): ResolvedCrossThreadCoordination {
  const incoming = input.incoming?.coordination;
  const explicitId = input.explicit?.id;
  const explicitSubjectRef = normalizedSubjectRef(input.explicit?.subjectRef);
  const incomingSubjectRef = normalizedSubjectRef(incoming?.subjectRef);
  const subjectContinues = !explicitSubjectRef || explicitSubjectRef === incomingSubjectRef;
  const continuesActive =
    incoming?.phase === 'active' && (!explicitId || explicitId === incoming.id) && subjectContinues;
  const reopensTerminal = incoming?.phase === 'terminal' && explicitId === incoming.id;
  const forksIncomingSubject =
    incoming?.phase === 'active' && !subjectContinues && (!explicitId || explicitId === incoming.id);
  const usesMintedId = !continuesActive && (!explicitId || reopensTerminal || forksIncomingSubject);
  const id = continuesActive
    ? incoming.id
    : explicitId && !reopensTerminal && !forksIncomingSubject
      ? explicitId
      : mintId();
  const subjectRef = continuesActive ? incomingSubjectRef : explicitSubjectRef;
  return {
    coordination: { id, phase: 'active', hop: nextHop(input.incoming, id), ...(subjectRef ? { subjectRef } : {}) },
    suppressRouting: false,
    ...(usesMintedId ? { contentDedupCoordinationKey: 'minted-active-root' as const } : {}),
  };
}

function resolveExplicitTerminal(input: ResolveInput, mintId: () => string): ResolvedCrossThreadCoordination {
  const incoming = input.incoming?.coordination;
  const explicitId = input.explicit?.id;
  const incomingSubjectRef = normalizedSubjectRef(incoming?.subjectRef);
  const explicitSubjectRef = normalizedSubjectRef(input.explicit?.subjectRef);
  // Close the lineage that triggered this invocation. A caller-supplied id may
  // seed a standalone terminal relay, but cannot fork a terminal ACK into a new
  // routable terminal chain. Conflicts fail before persistence instead of
  // silently terminalizing either lineage.
  if (incoming?.id && explicitId && incoming.id !== explicitId) {
    return {
      suppressRouting: true,
      conflict: {
        kind: 'coordination_id_conflict',
        message: 'Explicit terminal coordination id conflicts with the incoming coordination lineage.',
        incomingCoordinationId: incoming.id,
        explicitCoordinationId: explicitId,
      },
    };
  }
  if (incoming?.id && incomingSubjectRef && explicitSubjectRef && incomingSubjectRef !== explicitSubjectRef) {
    return {
      suppressRouting: true,
      conflict: {
        kind: 'coordination_subject_conflict',
        message: 'Explicit terminal coordination subject conflicts with the incoming coordination lineage.',
        coordinationId: incoming.id,
        incomingSubjectRef,
        explicitSubjectRef,
      },
    };
  }
  const usesMintedId = !incoming?.id && !explicitId;
  const id = incoming?.id ?? explicitId ?? mintId();
  const isAck =
    incoming?.phase === 'terminal' && id === incoming.id && input.targetThreadId === input.incoming?.sourceThreadId;
  const subjectRef = incomingSubjectRef ?? explicitSubjectRef;
  return {
    coordination: {
      id,
      phase: isAck ? 'ack' : 'terminal',
      hop: nextHop(input.incoming, id),
      ...(subjectRef ? { subjectRef } : {}),
    },
    suppressRouting: isAck,
    ...(usesMintedId ? { contentDedupCoordinationKey: 'minted-terminal-root' as const } : {}),
  };
}

/**
 * Pure lifecycle projection for F167 Phase R.
 *
 * No content is inspected. An implicit active reply inherits only when it is
 * sent back to the incoming source thread; local owner-thread work must opt in
 * explicitly. Terminal closes the chain, and an explicit active transition
 * after terminal starts a fresh id.
 */
export function resolveCrossThreadCoordination(input: ResolveInput): ResolvedCrossThreadCoordination {
  const mintId = input.mintId ?? (() => `coord-${randomUUID()}`);
  const incomingCoordination = input.incoming?.coordination;

  if (input.explicit?.phase === 'active') {
    return resolveExplicitActive(input, mintId);
  }

  if (input.explicit?.phase === 'terminal') {
    return resolveExplicitTerminal(input, mintId);
  }

  if (incomingCoordination?.phase === 'active' && input.targetThreadId === input.incoming?.sourceThreadId) {
    return {
      coordination: {
        id: incomingCoordination.id,
        phase: 'active',
        hop: incomingCoordination.hop + 1,
        ...(incomingCoordination.subjectRef ? { subjectRef: incomingCoordination.subjectRef } : {}),
      },
      suppressRouting: false,
    };
  }

  if (incomingCoordination?.phase === 'terminal' && input.targetThreadId === input.incoming?.sourceThreadId) {
    return {
      coordination: {
        id: incomingCoordination.id,
        phase: 'ack',
        hop: incomingCoordination.hop + 1,
        ...(incomingCoordination.subjectRef ? { subjectRef: incomingCoordination.subjectRef } : {}),
      },
      suppressRouting: true,
    };
  }

  return { suppressRouting: false };
}
