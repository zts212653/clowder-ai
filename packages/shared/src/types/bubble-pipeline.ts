export const BUBBLE_KINDS = ['assistant_text', 'thinking', 'tool_or_cli', 'rich_block', 'system_status'] as const;

export type BubbleKind = (typeof BUBBLE_KINDS)[number];

export const BUBBLE_EVENT_TYPES = [
  'local_placeholder_created',
  'stream_started',
  'stream_chunk',
  'thinking_chunk',
  'tool_event',
  'cli_output',
  'rich_block',
  'callback_final',
  'history_hydrate',
  'draft_restore',
  'cache_restore',
  'done',
  'error',
  'timeout',
] as const;

export type BubbleEventType = (typeof BUBBLE_EVENT_TYPES)[number];

export type BubbleOriginPhase = 'draft/local' | 'stream' | 'callback/history';

export type BubbleSourcePath =
  | 'active'
  | 'background'
  | 'callback'
  | 'hydration'
  | 'queue'
  | 'draft'
  | 'idb'
  | 'replay'
  | 'unknown';

export type BubbleRecoveryAction = 'catch-up' | 'quarantine' | 'sot-override' | 'none';

export type BubbleViolationKind = 'duplicate' | 'phase-regression' | 'canonical-split';

export interface BubbleStableIdentity {
  threadId: string;
  actorId: string;
  canonicalInvocationId: string;
  bubbleKind: BubbleKind;
}

export interface BubbleInvariantViolation extends BubbleStableIdentity {
  eventType: BubbleEventType;
  originPhase: BubbleOriginPhase;
  sourcePath: BubbleSourcePath;
  existingMessageId: string | null;
  incomingMessageId: string | null;
  seq: number | null;
  recoveryAction: BubbleRecoveryAction;
  violationKind: BubbleViolationKind;
  timestamp: number;
}

const bubbleKindSet = new Set<string>(BUBBLE_KINDS);
const bubbleEventTypeSet = new Set<string>(BUBBLE_EVENT_TYPES);

export function isBubbleKind(value: unknown): value is BubbleKind {
  return typeof value === 'string' && bubbleKindSet.has(value);
}

export function isBubbleEventType(value: unknown): value is BubbleEventType {
  return typeof value === 'string' && bubbleEventTypeSet.has(value);
}
