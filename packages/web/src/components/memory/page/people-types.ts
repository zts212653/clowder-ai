import {
  type CandidateInteractionDraft,
  type MaterializableClaimPayload,
  type PersonMemoryProposalView,
  temporalValueSchema,
} from '@cat-cafe/shared';
import { hasValidOriginalProposals, isPersonProposal } from './original-proposal-read';

interface PersonIdentityRead {
  personId: string;
  displayName: string;
  aliases: string[];
  status: string;
  createdAt: number;
  updatedAt: number;
}
export interface MemoryPerson extends PersonIdentityRead {
  currentClaimCount: number;
  activeInteractionCount: number;
}
export interface PersonClaim {
  claimId: string;
  revision: string;
  payload: MaterializableClaimPayload | { kind: 'redacted' };
  status: string;
  recordedAt: number;
  sourceCount: number;
}
export interface PersonInteraction {
  eventId: string;
  revision: string;
  eventKind: string;
  headline: string;
  status: string;
  recordedAt: number;
  sourceCount: number;
  occurredAt?: CandidateInteractionDraft['payload']['occurredAt'];
  duration?: CandidateInteractionDraft['payload']['duration'];
  importanceOrTopic?: string;
  uncertaintyNotes?: string[];
}
export interface PersonDetail extends PersonIdentityRead {
  personRevision: string;
  sourceCount: number;
  claims: PersonClaim[];
  relationships: { relationshipId: string; status: string; sourceCount: number }[];
  interactions: PersonInteraction[];
  proposals?: PersonMemoryProposalView[];
  truncation: { claims: boolean; relationships: boolean; interactions: boolean; proposals?: boolean };
}
export interface PeoplePage {
  readStatus: 'ready';
  entries: MemoryPerson[];
  meta: { count: number; limit: number; offset: number; hasMore: boolean; nextOffset?: number };
}
export type PersonSource =
  | { kind: 'message'; title: string | null; threadId: string; messageId: string; canOpen: true }
  | { kind: 'owner_action'; label: string; occurredAt: number; canOpen: false };
export interface PersonSources {
  status: 'ready' | 'unavailable';
  sources: PersonSource[];
}
export type PersonOwnerCommand =
  | { action: 'correct_claim'; claimId: string; expectedRevision: string; payload: MaterializableClaimPayload }
  | { action: 'retire_claim'; claimId: string; expectedRevision: string }
  | { action: 'amend_event'; eventId: string; expectedRevision: string; payload: CandidateInteractionDraft['payload'] }
  | { action: 'hard_forget_person'; expectedPersonRevision: string; confirmed: true };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const time = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown) => Array.isArray(value) && value.every(text);
function isPersonIdentity(value: unknown): value is PersonIdentityRead {
  return (
    record(value) &&
    ['personId', 'displayName', 'status'].every((key) => text(value[key])) &&
    strings(value.aliases) &&
    time(value.createdAt) &&
    time(value.updatedAt)
  );
}
function isPerson(value: unknown): value is MemoryPerson {
  return (
    isPersonIdentity(value) && record(value) && count(value.currentClaimCount) && count(value.activeInteractionCount)
  );
}
export function isPeoplePage(value: unknown): value is PeoplePage {
  if (
    !record(value) ||
    value.readStatus !== 'ready' ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isPerson) ||
    !record(value.meta)
  )
    return false;
  const meta = value.meta;
  return (
    ['count', 'limit', 'offset'].every((key) => count(meta[key])) &&
    meta.count === value.entries.length &&
    typeof meta.hasMore === 'boolean' &&
    (!meta.hasMore || (count(meta.nextOffset) && Number(meta.nextOffset) > Number(meta.offset)))
  );
}
function isClaim(value: unknown): value is PersonClaim {
  if (
    !record(value) ||
    !['claimId', 'revision', 'status'].every((key) => text(value[key])) ||
    !time(value.recordedAt) ||
    !count(value.sourceCount) ||
    !record(value.payload)
  )
    return false;
  const payload = value.payload;
  return (
    payload.kind === 'redacted' ||
    (payload.assertedBy === 'owner' &&
      ((payload.kind === 'reported_fact' && text(payload.predicate) && 'value' in payload) ||
        (payload.kind === 'user_assessment' &&
          text(payload.statement) &&
          ['endorsed', 'rejected', 'uncertain'].includes(String(payload.stance)))))
  );
}
function isInteraction(value: unknown): value is PersonInteraction {
  return (
    record(value) &&
    ['eventId', 'revision', 'headline', 'status'].every((key) => text(value[key])) &&
    ['conversation', 'meeting', 'message', 'milestone', 'other'].includes(String(value.eventKind)) &&
    time(value.recordedAt) &&
    count(value.sourceCount) &&
    (value.occurredAt === undefined || temporalValueSchema.safeParse(value.occurredAt).success) &&
    (value.duration === undefined || temporalValueSchema.safeParse(value.duration).success) &&
    (value.importanceOrTopic === undefined || text(value.importanceOrTopic)) &&
    (value.uncertaintyNotes === undefined || strings(value.uncertaintyNotes))
  );
}
export function isPersonDetail(value: unknown): value is PersonDetail {
  const truncation = record(value) ? value.truncation : null;
  return (
    isPersonIdentity(value) &&
    record(value) &&
    text(value.personRevision) &&
    count(value.sourceCount) &&
    Array.isArray(value.claims) &&
    value.claims.every(isClaim) &&
    Array.isArray(value.interactions) &&
    value.interactions.every(isInteraction) &&
    Array.isArray(value.relationships) &&
    value.relationships.every(
      (item) => record(item) && text(item.relationshipId) && text(item.status) && count(item.sourceCount),
    ) &&
    record(truncation) &&
    ['claims', 'relationships', 'interactions'].every((key) => typeof truncation[key] === 'boolean') &&
    (truncation.proposals === undefined || typeof truncation.proposals === 'boolean') &&
    hasValidOriginalProposals(value, isPersonProposal)
  );
}
export function isPersonSources(value: unknown): value is PersonSources {
  return (
    record(value) &&
    (value.status === 'ready' || value.status === 'unavailable') &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) =>
        record(source) &&
        ((source.kind === 'owner_action' &&
          source.canOpen === false &&
          text(source.label) &&
          time(source.occurredAt)) ||
          (source.kind === 'message' &&
            source.canOpen === true &&
            text(source.threadId) &&
            text(source.messageId) &&
            (source.title === null || text(source.title)))),
    )
  );
}
export function personClaimText(payload: PersonClaim['payload']): string {
  if (payload.kind === 'redacted') return '这条内容已遗忘';
  if (payload.kind === 'user_assessment') return payload.statement;
  return `${payload.predicate}：${typeof payload.value === 'string' ? payload.value : JSON.stringify(payload.value)}`;
}
