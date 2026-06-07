/**
 * F192 Phase G — Signal builders for Task Outcome Episode.
 *
 * Each builder takes raw context from the harness layer and produces
 * a validated signal record that can be appended to an episode.
 *
 * - Permission Cancel: built when user denies a tool call
 * - Magic Word: built when CVO uses a magic word
 * - A1 World Truth: built when merge/revert/test/build events occur
 */
import {
  type A1WorldTruthRecord,
  type CancelReason,
  type MagicWordRecord,
  type PermissionCancelRecord,
  parseA1WorldTruthRecord,
  parseMagicWordRecord,
  parsePermissionCancelRecord,
} from './task-outcome-episode.js';

const MAX_SUMMARY_LEN = 200;

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function isoNow(): string {
  return new Date().toISOString();
}

// ---- Permission Cancel ----

export interface BuildPermissionCancelInput {
  toolName: string;
  paramsSummary?: string;
  reason?: CancelReason;
  catId: string;
  threadId: string;
  sessionId?: string;
}

export function buildPermissionCancelSignal(input: BuildPermissionCancelInput): PermissionCancelRecord {
  return parsePermissionCancelRecord({
    type: 'permission_cancel',
    toolName: input.toolName,
    paramsSummary: truncate(input.paramsSummary, MAX_SUMMARY_LEN),
    reason: input.reason ?? 'skip',
    timestamp: isoNow(),
    catId: input.catId,
    threadId: input.threadId,
    sessionId: input.sessionId,
  });
}

// ---- Magic Word ----

export interface BuildMagicWordInput {
  word: string;
  catId: string;
  threadId: string;
  precedingMessageSummary?: string;
  followingMessageSummary?: string;
}

export function buildMagicWordSignal(input: BuildMagicWordInput): MagicWordRecord {
  return parseMagicWordRecord({
    type: 'magic_word',
    word: input.word,
    timestamp: isoNow(),
    threadId: input.threadId,
    catId: input.catId,
    precedingMessageSummary: truncate(input.precedingMessageSummary, MAX_SUMMARY_LEN),
    followingMessageSummary: truncate(input.followingMessageSummary, MAX_SUMMARY_LEN),
  });
}

// ---- A1 World Truth ----

export interface BuildA1WorldTruthInput {
  type: A1WorldTruthRecord['type'];
  ref: string;
  outcome: A1WorldTruthRecord['outcome'];
}

export function buildA1WorldTruthSignal(input: BuildA1WorldTruthInput): A1WorldTruthRecord {
  return parseA1WorldTruthRecord({
    type: input.type,
    ref: input.ref,
    outcome: input.outcome,
    timestamp: isoNow(),
  });
}
