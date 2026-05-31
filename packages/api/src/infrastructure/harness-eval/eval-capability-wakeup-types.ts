import type { AuditEvent } from '../../domains/cats/services/orchestration/EventAuditLog.js';
import type { TranscriptEvent } from '../../domains/cats/services/session/TranscriptReader.js';
import type { SkillLoadedEvent, ToolEvent } from '../../domains/cats/services/tool-usage/event-log-types.js';

export type CapabilityName = 'workspace-navigator' | 'rich-messaging' | 'browser-preview' | string;
export type CapabilityTrialOutcome = 'negative' | 'false_positive' | 'miss';
export type CapabilityMissLabel =
  | CapabilityTrialOutcome
  | 'reachability_doubt'
  | 'cognitive'
  | 'behavioral'
  | 'attention_dilution'
  | 'unclassified';

export interface CapabilityPreviewAvailability {
  worktreeId?: string;
  observedAt?: number;
  hasLivePort: boolean;
  port?: number;
}

export interface CapabilityTextEvent {
  eventNo: number;
  invocationId: string;
  timestamp: number;
  content: string;
  tokenCount: number;
  structuredSignalCount: number;
}

export interface NormalizedTranscriptToolUse {
  invocationId: string;
  eventNo: number;
  timestamp: number;
  toolName: string;
  normalizedToolName: string;
  toolInput?: Record<string, unknown>;
  changedFiles: string[];
  referencedPaths: string[];
}

export interface EvidenceScope {
  threadId: string;
  catId: string;
  sessionIds: string[];
  worktreeId?: string;
  windowStartMs: number;
  windowEndMs: number;
}

export interface NormalizedCapabilityUsageCandidate {
  source: 'tool' | 'audit';
  sourceId: string;
  capability: CapabilityName;
  threadId?: string;
  catId?: string;
  sessionId?: string;
  worktreeId?: string;
  timestamp: number;
  action?: string;
  path?: string;
  successful: boolean;
}

export interface CapabilityInvocationTrace {
  invocationId: string;
  invocationIndex: number;
  eventNoStart: number;
  eventNoEnd: number;
  startTime: number;
  endTime: number;
  changedFiles: string[];
  referencedPaths: string[];
  textEvents: CapabilityTextEvent[];
  transcriptToolUses: NormalizedTranscriptToolUse[];
  normalizedUsageCandidates: NormalizedCapabilityUsageCandidate[];
  toolEvents: ToolEvent[];
  skillLoadEvents: SkillLoadedEvent[];
  scenarioDetections: Record<string, boolean>;
}

export interface CapabilityTrace {
  kind: 'capability';
  sessionId: string;
  threadId: string;
  catId: string;
  worktreeId?: string;
  family?: string;
  invocations: CapabilityInvocationTrace[];
  auditEvents: AuditEvent[];
  normalizedAuditCandidates: NormalizedCapabilityUsageCandidate[];
  previewAvailability: CapabilityPreviewAvailability[];
}

export interface CapabilityTraceInput {
  sessionId: string;
  threadId: string;
  catId: string;
  worktreeId?: string;
  family?: string;
  transcriptEvents: TranscriptEvent[];
  toolEvents: ToolEvent[];
  skillLoadEvents?: SkillLoadedEvent[];
  auditEvents?: AuditEvent[];
  previewAvailability?: CapabilityPreviewAvailability[];
}

export interface ScenarioThenCapabilityPredicate {
  type: 'scenario_then_capability_predicate';
  capability: CapabilityName;
  scenarioKey: string;
}

export interface TextPatternThenCapabilityPredicate {
  type: 'text_pattern_then_capability';
  capability: CapabilityName;
  patterns: string[];
}

export interface MultiMsgTextVolumeThresholdPredicate {
  type: 'multi_msg_text_volume_threshold';
  capability: CapabilityName;
  minTokenCount: number;
  minStructuredSignals: number;
}

export interface FileChangeThenCapabilityPredicate {
  type: 'file_change_then_capability';
  capability: CapabilityName;
  includeGlobs: string[];
  excludeGlobs?: string[];
  requirePathMention?: boolean;
  requireLivePreview?: boolean;
}

export type CapabilityPredicate =
  | ScenarioThenCapabilityPredicate
  | TextPatternThenCapabilityPredicate
  | MultiMsgTextVolumeThresholdPredicate
  | FileChangeThenCapabilityPredicate;

export interface CapabilityWakeupRule {
  id: string;
  capability: CapabilityName;
  predicate: CapabilityPredicate;
}

export interface CapabilityWakeupTrial {
  ruleId: string;
  capability: CapabilityName;
  sessionId: string;
  threadId: string;
  catId: string;
  family?: string;
  window: {
    currentInvocationId: string;
    nextInvocationId?: string;
    invocationIndex: number;
  };
  eventNoSpan: { start: number; end: number };
  timeSpan: { startMs: number; endMs: number };
  outcome: CapabilityTrialOutcome;
  zeroFrictionDefault: boolean;
  opportunityEvidence: string[];
  usageEvidence: string[];
}

export interface ClassifiedCapabilityWakeupTrial extends CapabilityWakeupTrial {
  label: CapabilityMissLabel;
}

export const CHANGE_TOOL_NAMES = new Set(['write', 'edit', 'multiedit', 'file_change']);

export const DOUBT_PATTERNS = [
  /Hub\s+(专属|only)/i,
  /(terminal|CLI).{0,6}(调不了|can.?t\s+(call|use))/i,
  /(我|I).{0,8}(没有|don.?t have).{0,8}(工具|tool)/i,
  /(怎么|how to).{0,8}(调用|call|用这个)/i,
];

export const HOW_TO_PATH_HINTS: Record<string, string[]> = {
  'workspace-navigator': ['workspace-navigator/SKILL.md', 'capability-wakeup-index.md'],
  'browser-preview': ['browser-preview/SKILL.md', 'capability-wakeup-index.md'],
  'rich-messaging': ['rich-messaging/SKILL.md', 'capability-wakeup-index.md'],
};

export const CAPABILITY_SKILL_IDS: Record<string, string[]> = {
  'workspace-navigator': ['workspace-navigator'],
  'browser-preview': ['browser-preview'],
  'rich-messaging': ['rich-messaging'],
};
