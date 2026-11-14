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
      incomingCoordinationId?: string;
      explicitCoordinationId: string;
    }
  | {
      kind: 'coordination_subject_conflict';
      message: string;
      coordinationId: string;
      incomingSubjectRef?: string;
      explicitSubjectRef: string;
    };

interface ResolveInput {
  explicit?: CrossThreadCoordinationInput;
  incoming?: IncomingCrossThreadCoordination;
  verifiedOutboundActive?: CrossThreadCoordination;
  outboundConflict?: CrossThreadCoordinationConflict;
  targetThreadId: string;
  /** Any authored routing credential is an instruction, never courtesy prose. */
  hasExplicitRoutingIntent?: boolean;
  mintId?: () => string;
}

function nextHop(incoming: IncomingCrossThreadCoordination | undefined, id: string): number {
  return incoming?.coordination.id === id ? incoming.coordination.hop + 1 : 0;
}

function normalizedSubjectRef(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function selectActiveLineage(
  incoming: CrossThreadCoordination | undefined,
  explicitId: string | undefined,
  subjectContinues: boolean,
): { readonly continuesActive: boolean; readonly mintNewId: boolean } {
  if (incoming?.phase === 'active' && (!explicitId || explicitId === incoming.id)) {
    return { continuesActive: subjectContinues, mintNewId: !subjectContinues };
  }
  const reopensTerminal = incoming?.phase === 'terminal' && explicitId === incoming.id;
  return { continuesActive: false, mintNewId: !explicitId || reopensTerminal };
}

function resolveExplicitActive(input: ResolveInput, mintId: () => string): ResolvedCrossThreadCoordination {
  const incoming = input.incoming?.coordination;
  const explicitId = input.explicit?.id;
  const explicitSubjectRef = normalizedSubjectRef(input.explicit?.subjectRef);
  const incomingSubjectRef = normalizedSubjectRef(incoming?.subjectRef);
  const subjectContinues = !explicitSubjectRef || explicitSubjectRef === incomingSubjectRef;
  const lineage = selectActiveLineage(incoming, explicitId, subjectContinues);
  const id =
    lineage.continuesActive && incoming ? incoming.id : lineage.mintNewId || !explicitId ? mintId() : explicitId;
  const subjectRef = lineage.continuesActive ? incomingSubjectRef : explicitSubjectRef;
  return {
    coordination: { id, phase: 'active', hop: nextHop(input.incoming, id), ...(subjectRef ? { subjectRef } : {}) },
    suppressRouting: false,
    ...(lineage.mintNewId ? { contentDedupCoordinationKey: 'minted-active-root' as const } : {}),
  };
}

function resolveVerifiedOutboundTerminal(
  outboundActive: CrossThreadCoordination,
  explicitSubjectRef: string | undefined,
): ResolvedCrossThreadCoordination {
  const boundSubjectRef = normalizedSubjectRef(outboundActive.subjectRef);
  if (explicitSubjectRef && boundSubjectRef !== explicitSubjectRef) {
    return {
      suppressRouting: true,
      conflict: {
        kind: 'coordination_subject_conflict',
        message: 'Explicit terminal coordination subject conflicts with the bound outbound coordination.',
        coordinationId: outboundActive.id,
        ...(boundSubjectRef ? { incomingSubjectRef: boundSubjectRef } : {}),
        explicitSubjectRef,
      },
    };
  }
  const subjectRef = boundSubjectRef ?? explicitSubjectRef;
  return {
    coordination: {
      id: outboundActive.id,
      phase: 'terminal',
      hop: outboundActive.hop + 1,
      ...(subjectRef ? { subjectRef } : {}),
    },
    suppressRouting: false,
  };
}

function checkIncomingTerminalConflict(
  incoming: CrossThreadCoordination | undefined,
  explicitId: string | undefined,
  incomingSubjectRef: string | undefined,
  explicitSubjectRef: string | undefined,
): CrossThreadCoordinationConflict | undefined {
  if (explicitId && explicitId !== incoming?.id) {
    const message = incoming?.id
      ? 'Explicit terminal coordination id conflicts with the incoming coordination lineage.'
      : 'Explicit terminal coordination id is not bound to an active coordination from this invocation.';
    return {
      kind: 'coordination_id_conflict',
      message,
      ...(incoming?.id ? { incomingCoordinationId: incoming.id } : {}),
      explicitCoordinationId: explicitId,
    };
  }
  if (incoming?.id && incomingSubjectRef && explicitSubjectRef && incomingSubjectRef !== explicitSubjectRef) {
    return {
      kind: 'coordination_subject_conflict',
      message: 'Explicit terminal coordination subject conflicts with the incoming coordination lineage.',
      coordinationId: incoming.id,
      incomingSubjectRef,
      explicitSubjectRef,
    };
  }
  return undefined;
}

function resolveExplicitTerminal(input: ResolveInput, mintId: () => string): ResolvedCrossThreadCoordination {
  if (input.outboundConflict) return { suppressRouting: true, conflict: input.outboundConflict };
  const explicitId = input.explicit?.id;
  const explicitSubjectRef = normalizedSubjectRef(input.explicit?.subjectRef);
  if (input.verifiedOutboundActive && explicitId === input.verifiedOutboundActive.id) {
    return resolveVerifiedOutboundTerminal(input.verifiedOutboundActive, explicitSubjectRef);
  }
  const incoming = input.incoming?.coordination;
  const incomingSubjectRef = normalizedSubjectRef(incoming?.subjectRef);
  const conflict = checkIncomingTerminalConflict(incoming, explicitId, incomingSubjectRef, explicitSubjectRef);
  if (conflict) return { suppressRouting: true, conflict };

  const usesMintedId = !incoming?.id && !explicitId;
  const id = incoming?.id ?? mintId();
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

function reopensIncomingTerminal(input: ResolveInput): boolean {
  const incoming = input.incoming?.coordination;
  return Boolean(
    input.hasExplicitRoutingIntent &&
      incoming?.phase === 'terminal' &&
      input.targetThreadId === input.incoming?.sourceThreadId &&
      (!input.explicit?.id || input.explicit.id === incoming.id),
  );
}

export function resolveCrossThreadCoordination(input: ResolveInput): ResolvedCrossThreadCoordination {
  const mintId = input.mintId ?? (() => `coord-${randomUUID()}`);
  const incomingCoordination = input.incoming?.coordination;

  if (input.explicit?.phase === 'active') return resolveExplicitActive(input, mintId);
  if (reopensIncomingTerminal(input)) {
    const subjectRef = input.explicit?.subjectRef;
    return resolveExplicitActive(
      { ...input, explicit: { phase: 'active', ...(subjectRef ? { subjectRef } : {}) } },
      mintId,
    );
  }
  if (input.explicit?.phase === 'terminal') return resolveExplicitTerminal(input, mintId);

  if (incomingCoordination && input.targetThreadId === input.incoming?.sourceThreadId) {
    if (incomingCoordination.phase === 'active' || incomingCoordination.phase === 'terminal') {
      const isAck = incomingCoordination.phase === 'terminal';
      return {
        coordination: {
          id: incomingCoordination.id,
          phase: isAck ? 'ack' : 'active',
          hop: incomingCoordination.hop + 1,
          ...(incomingCoordination.subjectRef ? { subjectRef: incomingCoordination.subjectRef } : {}),
        },
        suppressRouting: isAck,
      };
    }
  }

  return { suppressRouting: false };
}
