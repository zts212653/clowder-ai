import type { MessageContent, RichBlock } from '@cat-cafe/shared';

export interface AbstractiveMessage {
  id: string;
  content: string;
  catId?: string;
  timestamp: number;
  contentBlocks?: readonly MessageContent[];
  richBlocks?: readonly RichBlock[];
  quotedAuthors?: Readonly<Record<string, string>>;
}

export interface AbstractiveInput {
  previousSummary: string | null;
  messages: AbstractiveMessage[];
  threadId: string;
}

/** Provider usage is available even when parsing or the later transaction fails. */
export interface SummaryGenerationUsage {
  threadId: string;
  messageCount: number;
  modelId: string;
  totalTokens: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  elapsedMs?: number;
}

export interface SummaryAttempt extends SummaryGenerationUsage {
  /** True only after the summary transaction commits. */
  success: boolean;
}

export interface TopicSegment {
  summary: string;
  topicKey: string;
  topicLabel: string;
  boundaryReason: string;
  boundaryConfidence: 'high' | 'medium' | 'low';
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  relatedSegmentIds?: string[];
  candidates?: DurableCandidate[];
}

export interface DurableCandidate {
  kind: 'decision' | 'lesson' | 'method';
  title: string;
  claim: string;
  why_durable: string;
  evidence: Array<{ threadId: string; messageId: string; span: string }>;
  relatedAnchors: string[];
  confidence: 'explicit' | 'inferred';
}

export interface AbstractiveResult {
  segments: TopicSegment[];
  modelId?: string;
  promptVersion?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number };
  curationState?: import('./curation/LunaCurationState.js').LunaCurationState;
}
