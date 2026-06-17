/**
 * F192 Phase G — Signal builders for Task Outcome Episode.
 *
 * Each builder takes raw context from the harness layer and produces
 * a validated signal record that can be appended to an episode.
 *
 * - Permission Cancel: built when user denies a tool call
 * - Proposal Reject: built when user rejects a cat's proposal (F128 thread / F225 handoff)
 * - Magic Word: built when operator uses a magic word
 * - A1 World Truth: built when merge/revert/test/build events occur
 */
import {
  type A1WorldTruthRecord,
  type CancelReason,
  type MagicWordRecord,
  type MagicWordRefRecord,
  type PermissionCancelRecord,
  type ProposalRejectRecord,
  type ProposalRejectType,
  parseA1WorldTruthRecord,
  parseMagicWordRecord,
  parseMagicWordRefRecord,
  parsePermissionCancelRecord,
  parseProposalRejectRecord,
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

// ---- Proposal Reject ----

export interface BuildProposalRejectInput {
  proposalId: string;
  proposalType: ProposalRejectType;
  catId: string;
  threadId: string;
  proposalTitle?: string;
  rejectionReason?: string;
}

export function buildProposalRejectSignal(input: BuildProposalRejectInput): ProposalRejectRecord {
  return parseProposalRejectRecord({
    type: 'proposal_reject',
    proposalId: input.proposalId,
    proposalType: input.proposalType,
    catId: input.catId,
    threadId: input.threadId,
    proposalTitle: truncate(input.proposalTitle, MAX_SUMMARY_LEN),
    rejectionReason: truncate(input.rejectionReason, MAX_SUMMARY_LEN),
    timestamp: isoNow(),
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

// F227 归一 (superseded by buildMagicWordRefSignal): Event Memory is the truth
// source for magic words. Retained only for the deprecated manual route's handler.
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

// ---- Magic Word Ref (F227: lightweight episode pointer to Event Memory) ----

export interface BuildMagicWordRefInput {
  eventId: string;
  word: string;
  catId: string;
  threadId: string;
}

export function buildMagicWordRefSignal(input: BuildMagicWordRefInput): MagicWordRefRecord {
  return parseMagicWordRefRecord({
    type: 'magic_word_ref',
    eventId: input.eventId,
    word: input.word,
    timestamp: isoNow(),
    threadId: input.threadId,
    catId: input.catId,
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
