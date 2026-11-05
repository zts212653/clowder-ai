import type { RedisClient } from '@cat-cafe/shared/utils';
import { type EvalRepairApprovalRecord, projectEvalRepairApprovals } from './eval-repair-approval-projection.js';
import {
  EVAL_HISTORY_BYTE_LIMIT,
  EVAL_HISTORY_EVENT_LIMIT,
  EvalRepairHistoryKeys as keys,
} from './eval-repair-history-keys.js';
import { ReevalClosureKeys } from './reeval-closure-event-log.js';
import { type EvalLifecycleEvent, EvalLifecycleEventSchema } from './reeval-closure-schema.js';

const READ_REFS = `
local subject = redis.call('GET', KEYS[1])
if not subject then return {} end
local refs = redis.call('ZRANGE', KEYS[2], 0, tonumber(ARGV[1]))
return {subject, unpack(refs)}
`;
const READ_EVENTS = `
local result, bytes = {}, 0
for i=2,#ARGV do
  local encoded = redis.call('LINDEX', KEYS[1], tonumber(ARGV[i]))
  if not encoded then return redis.error_reply('F266 history event ref missing') end
  bytes = bytes + string.len(encoded)
  if bytes > tonumber(ARGV[1]) then return redis.error_reply('F266 history byte budget exceeded') end
  table.insert(result,encoded)
end
return result
`;

export function evalRepairHistoryTime(record: EvalRepairApprovalRecord): number {
  const time = record.supersededByCaseActionRef ? record.closedAt : record.decidedAt;
  return time ? Date.parse(time) : 0;
}

/** At most eight original event refs, never the entire subject, even for a very long lifecycle log. */
export async function readEvalRepairHistoryRecord(
  redis: RedisClient,
  proposalId: string,
  additions?: { subject: string; events: Map<number, EvalLifecycleEvent> },
): Promise<{ record: EvalRepairApprovalRecord; subject: string; sequences: number[] } | null> {
  const raw = await redis.eval(
    READ_REFS,
    2,
    keys.proposalSubject(proposalId),
    keys.proposalEvents(proposalId),
    String(EVAL_HISTORY_EVENT_LIMIT),
  );
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string'))
    throw new Error('F266 invalid history refs');
  const storedSubject = raw[0] as string | undefined;
  if (storedSubject && additions && storedSubject !== additions.subject)
    throw new Error('F266 proposal crosses subjects');
  const subject = storedSubject ?? additions?.subject;
  if (!subject) return null;
  const sequences = [...new Set([...raw.slice(1).map(Number), ...(additions?.events.keys() ?? [])])].sort(
    (a, b) => a - b,
  );
  if (
    !sequences.length ||
    sequences.length > EVAL_HISTORY_EVENT_LIMIT ||
    sequences.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error('F266 invalid history event window');
  const missing = sequences.filter((sequence) => !additions?.events.has(sequence));
  const original = missing.length
    ? await redis.eval(
        READ_EVENTS,
        1,
        ReevalClosureKeys.eventLog(subject),
        String(EVAL_HISTORY_BYTE_LIMIT),
        ...missing.map(String),
      )
    : [];
  if (
    !Array.isArray(original) ||
    original.length !== missing.length ||
    original.some((value) => typeof value !== 'string')
  )
    throw new Error('F266 canonical history read incomplete');
  const events = new Map(additions?.events);
  original.forEach((encoded, index) =>
    events.set(missing[index], EvalLifecycleEventSchema.parse(JSON.parse(encoded as string))),
  );
  const bytes = [...events.values()].reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event)), 0);
  if (bytes > EVAL_HISTORY_BYTE_LIMIT) throw new Error('F266 history byte budget exceeded');
  const records = projectEvalRepairApprovals(sequences.map((sequence) => events.get(sequence)!)).proposals;
  if ([...events.values()].some((event) => (event.caseId ?? event.verdictId) !== subject))
    throw new Error('F266 history event subject mismatch');
  if (records.length !== 1 || records[0].proposal.proposalId !== proposalId)
    throw new Error('F266 history proposal ref mismatch');
  return { record: records[0], subject, sequences };
}
