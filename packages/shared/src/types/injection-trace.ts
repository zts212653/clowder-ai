/**
 * F237 — Injection Trace types (v0)
 *
 * Observability layer for prompt injection — captures what was injected,
 * when, and through which delivery channel. Does NOT depend on hook
 * pipeline infrastructure (HookManifest, HookRegistry, etc.).
 */

/** Injection stage — maps to existing builder functions. */
export type InjectionStage = 'session-init' | 'per-turn';

/** Delivery channel for injected content. */
export type DeliveryChannel = 'message-prepend' | 'native-l0' | 'pack-only' | 'always-delivered';

/** Per-segment observation record. */
export interface ObservedSegment {
  segmentId: string;
  stage: InjectionStage;
  status: 'observed' | 'absent';
  contentHash: string | null;
  charCount: number;
}

/** Delivery decision for a stage. */
export interface StageDeliveryDecision {
  stage: InjectionStage;
  delivered: boolean;
  channel: DeliveryChannel;
  reason: string;
}

/** Compact per-turn summary — persistent (TTL=0). */
export interface InjectionTraceSummary {
  turnId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  segments: ObservedSegment[];
  delivery: StageDeliveryDecision[];
  totalCharCount: number;
  totalSegmentsObserved: number;
  totalSegmentsAbsent: number;
  durationMs: number;
}

/** Full trace detail — debug layer (TTL=7d). */
export interface InjectionTraceDetail {
  turnId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  sessionContentHash: string | null;
  turnContentHash: string | null;
  sessionCharCount: number;
  turnCharCount: number;
  segments: ObservedSegment[];
}
