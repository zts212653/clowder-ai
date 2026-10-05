import type { EntityConflictResolutionRequest } from '@cat-cafe/shared';
import type { EmbedModelInfo, EntityMutationContext, EntityRecord, EvidenceItem, SearchOptions } from './interfaces.js';
import type { MessagePassageSearchOptions } from './message-passage-search-types.js';

export type EmbeddingSnapshot = {
  ready: boolean;
  model: EmbedModelInfo;
  mode: 'off' | 'shadow' | 'on';
  passages: boolean;
};
export type MemoryProcessJob =
  | {
      kind: 'search';
      dbPath: string;
      query: string;
      options?: Omit<SearchOptions, 'signal'>;
      sourceRoot?: string;
      sourceRef?: string;
      embedding?: EmbeddingSnapshot;
      flags: Record<string, string>;
    }
  | {
      kind: 'message-search';
      dbPath: string;
      query: string;
      options: Omit<MessagePassageSearchOptions, 'signal'>;
      embedding?: EmbeddingSnapshot;
      flags: Record<string, string>;
    }
  | ({ kind: 'project-mentions'; dbPath: string; stagingPath: string } & MentionProjectionInput)
  | { kind: 'checkpoint'; dbPath: string }
  | {
      kind: 'scan';
      scanner: 'cat-cafe' | 'generic';
      root: string;
      excludes?: string[];
      options?: Record<string, unknown>;
      singlePath?: string;
    };
export interface ProcessError {
  name: string;
  message: string;
  stack?: string;
  details: Record<string, unknown>;
}
export type ParentMessage =
  | { type: 'run'; id: number; job: MemoryProcessJob; stderrToken: string }
  | {
      type: 'embedding-result';
      id: number;
      value?: unknown;
      ready: boolean;
      model?: EmbedModelInfo;
      error?: ProcessError;
    };
export type ChildMessage =
  | { type: 'result'; id: number; value?: unknown; error?: ProcessError }
  | { type: 'started'; id: number; pid: number }
  | { type: 'embedding'; id: number; method: 'load' | 'reprobeIfNeeded' | 'embed'; texts?: string[] };
export function encodeProcessError(error: unknown): ProcessError {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack, details: { ...error } }
    : { name: 'Error', message: String(error), details: {} };
}

export type MentionProjectionInput =
  | { operation: 'entities'; entities: EntityRecord[]; context: EntityMutationContext }
  | {
      operation: 'resolve-entity';
      incoming: EntityRecord;
      resolution: EntityConflictResolutionRequest;
      context: EntityMutationContext;
    }
  | { operation: 'mentions'; docAnchors?: string[] };
export interface MentionProjectionResult {
  sourceRevision: number;
  entityIds?: string[];
  docAnchors?: string[];
  changed: boolean;
}

export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}
