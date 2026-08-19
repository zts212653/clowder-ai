export type ReflectionOutputKind = 'decision' | 'correction' | 'identity_relationship' | 'open_loop' | 'desire_cue';

export type ReflectionDestination = 'public_evidence' | 'f255_private_cue';

export interface ReflectionSourceRef {
  threadId: string;
  messageId?: string;
  sessionId?: string;
  eventNo?: number;
  invocationId?: string;
  /** Canonical transcript event time used only to order competing source anchors. */
  eventAt?: number;
}

export interface ReflectionTranscriptEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  sourceRef: ReflectionSourceRef;
}

export interface ExtractedReflectionDelta {
  kind: ReflectionOutputKind;
  destination: ReflectionDestination;
  normalizedClaim: string;
  reason: string;
  sourceRef: ReflectionSourceRef;
  targetCatId?: string;
}

export interface ExtractReflectionInput {
  catId: string;
  entries: ReflectionTranscriptEntry[];
}

export type ReflectionProjectionState = 'pending' | 'delivered';

export interface ReflectionOutputRecord extends ExtractedReflectionDelta {
  outputId: string;
  ownerUserId: string;
  householdLocalDate: string;
  catId: string;
  projectionState: ReflectionProjectionState;
  projectionRef?: string;
  producer: 'f271-session-close-v1';
  createdAt: string;
  deliveredAt?: string;
}

export interface ReflectionCueDeliveryRecord {
  outputId: string;
  ownerUserId: string;
  catId: string;
  projectionState: 'delivered';
  projectionRef: string;
  producer: 'f271-session-close-v1';
  createdAt: string;
  deliveredAt: string;
}

export interface ReflectionBatchInput {
  ownerUserId: string;
  catId: string;
  householdLocalDate: string;
  createdAt: string;
  budget: number;
  outputs: ExtractedReflectionDelta[];
  /** Event times observed in this scan, keyed by the durable source identity without eventAt. */
  sourceEventTimes?: Record<string, number>;
}

export interface ReflectionBatchResult {
  accepted: ReflectionOutputRecord[];
  duplicates: Array<{ outputId: string; existingOutputId: string }>;
  rejected: Array<{ outputId: string; reason: 'budget_exhausted' }>;
}
