export interface SteerParticipantActivity {
  catId: string;
  lastMessageAt: number;
  lastResponseHealthy?: boolean;
}

export interface SteerThreadCatProjection {
  participantActivity: SteerParticipantActivity[];
  /** Exact read-only result from the same head-time resolver used by Queue drain. */
  fallbackTargetCatId: string | null;
}

export interface SteerSourceTargetState {
  targetCatId: string;
  state: 'pending' | 'dispatched' | 'settled';
  /** True only while this target remains in Queue custody. */
  actionable: boolean;
  dispatchedAt?: number;
  statusMessageId?: string;
}

const SOURCE_TARGET_STATES = new Set<SteerSourceTargetState['state']>(['pending', 'dispatched', 'settled']);

export function parseSteerThreadCatProjection(body: unknown): SteerThreadCatProjection {
  if (!body || typeof body !== 'object') return { participantActivity: [], fallbackTargetCatId: null };
  const value = body as Record<string, unknown>;
  const participants = Array.isArray(value.participants) ? value.participants : [];
  return {
    participantActivity: participants.flatMap((participant: unknown) => {
      if (!participant || typeof participant !== 'object') return [];
      const candidate = participant as Record<string, unknown>;
      if (typeof candidate.catId !== 'string' || typeof candidate.lastMessageAt !== 'number') return [];
      return [
        {
          catId: candidate.catId,
          lastMessageAt: candidate.lastMessageAt,
          ...(typeof candidate.lastResponseHealthy === 'boolean'
            ? { lastResponseHealthy: candidate.lastResponseHealthy }
            : {}),
        },
      ];
    }),
    fallbackTargetCatId: typeof value.fallbackTargetCatId === 'string' ? value.fallbackTargetCatId : null,
  };
}

export function parseSteerSourceTargetStates(body: unknown): SteerSourceTargetState[] {
  if (!body || typeof body !== 'object') return [];
  const targets = (body as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target: unknown) => {
    if (!target || typeof target !== 'object') return [];
    const candidate = target as Record<string, unknown>;
    if (
      typeof candidate.targetCatId !== 'string' ||
      typeof candidate.state !== 'string' ||
      !SOURCE_TARGET_STATES.has(candidate.state as SteerSourceTargetState['state']) ||
      typeof candidate.actionable !== 'boolean'
    ) {
      return [];
    }
    return [
      {
        targetCatId: candidate.targetCatId,
        state: candidate.state as SteerSourceTargetState['state'],
        actionable: candidate.actionable,
        ...(typeof candidate.dispatchedAt === 'number' ? { dispatchedAt: candidate.dispatchedAt } : {}),
        ...(typeof candidate.statusMessageId === 'string' ? { statusMessageId: candidate.statusMessageId } : {}),
      },
    ];
  });
}

export function parseSteerSourceRecordId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>).sourceRecordId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
