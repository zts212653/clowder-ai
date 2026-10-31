import type { ProviderSemanticBase } from './provider-semantic-event.js';

export type ProviderSubexecutionStage = 'started' | 'message' | 'completed' | 'failed' | 'interrupted';

/**
 * Provider-neutral identity for work delegated inside one provider execution.
 * Provider thread/turn identifiers stay opaque coordinates; raw envelopes and
 * provider-specific item names never cross this boundary.
 */
export interface ProviderSubexecutionSemanticEvent extends ProviderSemanticBase {
  kind: 'subexecution';
  stage: ProviderSubexecutionStage;
  subexecutionId: string;
  rootExecutionId: string;
  parentExecutionId: string;
  rootTurnId: string;
  parentTurnId: string;
  turnId?: string;
  agentPath: string;
  nickname?: string;
  depth: number;
  content?: string;
  messagePhase?: 'commentary' | 'final_answer' | 'unknown';
}

const COMMON_KEYS = ['v', 'id', 'kind', 'occurredAt', 'invocationId', 'provenance'] as const;
const SUBEXECUTION_KEYS = [
  'stage',
  'subexecutionId',
  'rootExecutionId',
  'parentExecutionId',
  'rootTurnId',
  'parentTurnId',
  'turnId',
  'agentPath',
  'nickname',
  'depth',
  'content',
  'messagePhase',
] as const;
const SUBEXECUTION_STAGES: readonly ProviderSubexecutionStage[] = [
  'started',
  'message',
  'completed',
  'failed',
  'interrupted',
];

export function hasValidProviderSubexecutionPayload(value: Record<string, unknown>): boolean {
  const isMessage = value.stage === 'message';
  const hasTurn = isExactBoundedString(value.turnId, 512);
  return (
    hasOnlyKeys(value, [...COMMON_KEYS, ...SUBEXECUTION_KEYS]) &&
    isOneOf(value.stage, SUBEXECUTION_STAGES) &&
    isExactBoundedString(value.subexecutionId, 512) &&
    isExactBoundedString(value.rootExecutionId, 512) &&
    isExactBoundedString(value.parentExecutionId, 512) &&
    isExactBoundedString(value.rootTurnId, 512) &&
    isExactBoundedString(value.parentTurnId, 512) &&
    (value.turnId === undefined || hasTurn) &&
    isExactBoundedString(value.agentPath, 512) &&
    (value.nickname === undefined || isExactBoundedString(value.nickname, 160)) &&
    Number.isInteger(value.depth) &&
    Number(value.depth) >= 1 &&
    (isMessage
      ? hasTurn &&
        isNonBlankString(value.content) &&
        isOneOf(value.messagePhase, ['commentary', 'final_answer', 'unknown'] as const)
      : value.content === undefined && value.messagePhase === undefined && (value.stage === 'started' || hasTurn))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isExactBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= maxLength;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}
