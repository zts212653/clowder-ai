export type DebugEventName =
  | 'connect'
  | 'disconnect'
  | 'engine_close'
  | 'intent_mode'
  | 'history_replace'
  | 'queue_updated'
  | 'queue_paused'
  | 'agent_message'
  | 'bubble_lifecycle'
  | 'bubble_invariant_violation'
  | 'done'
  | 'rejoin_rooms';

export const EVENT_KEYS = [
  'event',
  'timestamp',
  'threadId',
  'action',
  'queueLength',
  'queueStatuses',
  'mode',
  'isFinal',
  'routeThreadId',
  'storeThreadId',
  'queuePaused',
  'hasActiveInvocation',
  'reason',
  'catId',
  'actorId',
  'messageId',
  'existingMessageId',
  'incomingMessageId',
  'invocationId',
  'canonicalInvocationId',
  'bubbleKind',
  'eventType',
  'originPhase',
  'sourcePath',
  'seq',
  'recoveryAction',
  'violationKind',
  'level',
  'origin',
] as const;

export type AllowedEventKey = (typeof EVENT_KEYS)[number];

export type StoredDebugEvent = {
  event: DebugEventName;
  timestamp: number;
  threadId?: string;
  action?: string;
  queueLength?: number;
  queueStatuses?: string[];
  mode?: string;
  isFinal?: boolean;
  routeThreadId?: string;
  storeThreadId?: string;
  queuePaused?: boolean;
  hasActiveInvocation?: boolean;
  reason?: string;
  catId?: string;
  actorId?: string;
  messageId?: string;
  existingMessageId?: string | null;
  incomingMessageId?: string | null;
  invocationId?: string;
  canonicalInvocationId?: string;
  bubbleKind?: string;
  eventType?: string;
  originPhase?: string;
  sourcePath?: string;
  seq?: number | null;
  recoveryAction?: string;
  violationKind?: string;
  level?: 'warn' | 'error';
  origin?: 'stream' | 'callback' | 'briefing';
};

export type DebugEventInput = Partial<StoredDebugEvent> & {
  event: DebugEventName;
  timestamp?: number;
};

export type DebugConfigureInput = {
  enabled?: boolean;
  size?: number;
  ttlMs?: number;
};

export type DebugDumpOptions = {
  rawThreadId?: boolean;
};

export type DebugDumpResult = {
  meta: {
    generatedAt: number;
    count: number;
    enabled: boolean;
    size: number;
    rawThreadId: boolean;
    marker: 'MASKED' | 'RAW';
    expiresAt: number | null;
  };
  events: StoredDebugEvent[];
};

export type DebugStatus = {
  enabled: boolean;
  size: number;
  count: number;
  expiresAt: number | null;
  ttlMsRemaining: number | null;
};

export type DebugWindowApi = {
  configure: (input: DebugConfigureInput) => DebugStatus;
  dump: (options?: DebugDumpOptions) => string;
  dumpBubbleTimeline: (options?: DebugDumpOptions) => string;
  clear: () => void;
  status: () => DebugStatus;
};
