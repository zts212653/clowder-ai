import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { continueSettledIndex, type SettledIndexCheckpoint } from '../../utils/settled-index-worker.js';
import {
  EVAL_HISTORY_BYTE_LIMIT,
  EVAL_HISTORY_EVENT_LIMIT,
  EvalRepairHistoryKeys as keys,
} from './eval-repair-history-keys.js';
import { evalRepairHistoryTime, readEvalRepairHistoryRecord } from './eval-repair-history-read.js';
import { ReevalClosureKeys } from './reeval-closure-event-log.js';
import { type EvalLifecycleEvent, EvalLifecycleEventSchema } from './reeval-closure-schema.js';

interface Progress {
  cursor: string;
  discovered: boolean;
  pending: string[];
  complete: boolean;
  batches: number;
  events: number;
}
const empty = (): Progress => ({ cursor: '0', discovered: false, pending: [], complete: false, batches: 0, events: 0 });
const checkpoint = (p: Progress): SettledIndexCheckpoint => ({
  complete: p.complete,
  batches: p.batches,
  detailReads: p.events,
  pendingKeys: p.pending.length,
});
const CHUNK = `
local size=redis.call('LLEN',KEYS[1])
local start=tonumber(ARGV[1])
if start>size then return redis.error_reply('F266 history sequence regressed') end
local result,bytes={tostring(size)},0
for sequence=start, math.min(size-1,start+tonumber(ARGV[2])-1) do
  local event=redis.call('LINDEX',KEYS[1],sequence)
  if bytes+string.len(event)>tonumber(ARGV[3]) then
    if #result==1 then return redis.error_reply('F266 history event exceeds byte budget') end
    break
  end
  bytes=bytes+string.len(event)
  table.insert(result,event)
end
return result
`;
const COMMIT = `
if redis.call('GET',KEYS[2])~=ARGV[1] or (redis.call('GET',KEYS[1]) or '')~=ARGV[2] then return 0 end
if KEYS[4]~='' and redis.call('LLEN',KEYS[4])~=tonumber(ARGV[4]) then return 0 end
local dirtyType=redis.call('TYPE',KEYS[3]).ok
local countsType=redis.call('TYPE',KEYS[6]).ok
if (dirtyType~='none' and dirtyType~='set') or (countsType~='none' and countsType~='hash') then return redis.error_reply('F266 history progress type conflict') end
local edits=cjson.decode(ARGV[7])
for _,edit in ipairs(edits) do
  local a=redis.call('TYPE',KEYS[edit.subjectKey]).ok
  local b=redis.call('TYPE',KEYS[edit.eventsKey]).ok
  local c=redis.call('TYPE',KEYS[edit.ownerKey]).ok
  if (a~='none' and a~='string') or (b~='none' and b~='zset') or (c~='none' and c~='zset') then return redis.error_reply('F266 history index type conflict') end
  local count=redis.call('HGET',KEYS[6],edit.owner)
  if count and (not string.match(count,'^%d+$') or not tonumber(count)) then return redis.error_reply('F266 history owner count corrupt') end
  if tonumber(count or '0')~=redis.call('ZCARD',KEYS[edit.ownerKey]) then return redis.error_reply('F266 history index coverage mismatch') end
  local prior=redis.call('GET',KEYS[edit.subjectKey])
  if prior and prior~=ARGV[5] then return redis.error_reply('F266 history proposal crosses subjects') end
end
for _,edit in ipairs(edits) do
  redis.call('SET',KEYS[edit.subjectKey],ARGV[5])
  for _,sequence in ipairs(edit.refs) do redis.call('ZADD',KEYS[edit.eventsKey],sequence,tostring(sequence)) end
  local present=redis.call('ZSCORE',KEYS[edit.ownerKey],edit.proposalId)
  redis.call('ZREM',KEYS[edit.ownerKey],edit.proposalId)
  if edit.visible then redis.call('ZADD',KEYS[edit.ownerKey],edit.time,edit.proposalId) end
  redis.call('HINCRBY',KEYS[6],edit.owner,(edit.visible and 1 or 0)-(present and 1 or 0))
end
if ARGV[5]~='' then
  redis.call('SET',KEYS[5],ARGV[6])
  if tonumber(ARGV[6])==tonumber(ARGV[4]) then redis.call('SREM',KEYS[3],ARGV[5]) end
end
local progress=cjson.decode(ARGV[3])
progress.complete=progress.discovered and #progress.pending==0 and redis.call('SCARD',KEYS[3])==0
local encoded=ARGV[3]
if progress.complete then encoded=string.gsub(encoded,'"complete":false','"complete":true',1) end
redis.call('SET',KEYS[1],encoded)
redis.call('DEL',KEYS[2])
return progress.complete and 2 or 1
`;
const RELEASE = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
const READ_EPOCH = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('EXISTS',KEYS[2])~=0 then return 0 end
local versionType=redis.call('TYPE',KEYS[3]).ok
if versionType~='none' and versionType~='string' then return redis.error_reply('F266 history read version type conflict') end
redis.call('SET',KEYS[3],ARGV[3])
redis.call('SET',KEYS[1],ARGV[2])
return 1
`;
const readEpochs = new WeakMap<RedisClient, Promise<boolean>>();

/** Revisit subject membership after rollback, preserving every event checkpoint and pending subject chunk. */
function beginReadEpoch(redis: RedisClient): Promise<boolean> {
  const existing = readEpochs.get(redis);
  if (existing) return existing;
  const attempt = (async () => {
    const raw = await redis.get(keys.progress);
    if (!raw) return true;
    const progress = JSON.parse(raw) as Progress;
    const next = JSON.stringify({ ...progress, complete: false, discovered: false, cursor: '0' });
    return (
      Number(
        await redis.eval(READ_EPOCH, 3, keys.progress, keys.lock, keys.version, raw, next, `read:${randomUUID()}`),
      ) === 1
    );
  })();
  readEpochs.set(redis, attempt);
  void attempt.then(
    (ready) => {
      if (!ready && readEpochs.get(redis) === attempt) readEpochs.delete(redis);
    },
    () => {
      if (readEpochs.get(redis) === attempt) readEpochs.delete(redis);
    },
  );
  return attempt;
}

export async function evalRepairHistoryPrepared(redis: RedisClient): Promise<boolean> {
  const raw = await redis.get(keys.progress);
  return !!raw && JSON.parse(raw).complete === true && (await redis.scard(keys.dirty)) === 0;
}

/** First read does one bounded step; the shared fair worker finishes even when its page is closed. */
export async function prepareEvalRepairHistory(redis: RedisClient): Promise<boolean> {
  if (!(await beginReadEpoch(redis))) return false;
  if (await evalRepairHistoryPrepared(redis)) return true;
  const result = await advanceEvalRepairHistory(redis);
  if (!result.complete) continueSettledIndex(redis, keys.progress, () => advanceEvalRepairHistory(redis));
  return result.complete;
}

export async function advanceEvalRepairHistory(redis: RedisClient): Promise<SettledIndexCheckpoint> {
  const prior = await redis.get(keys.progress);
  const progress: Progress = prior ? JSON.parse(prior) : empty();
  if (progress.complete && (await redis.scard(keys.dirty)) === 0) return checkpoint(progress);
  const token = randomUUID();
  if (!(await redis.set(keys.lock, token, 'PX', 30000, 'NX'))) return { ...checkpoint(progress), complete: false };
  try {
    if (!progress.discovered && !progress.pending.length) {
      const [cursor, subjects] = await redis.sscan(ReevalClosureKeys.verdicts, progress.cursor, 'COUNT', 8);
      if (
        subjects.length > 256 ||
        subjects.reduce((bytes, id) => bytes + Buffer.byteLength(id), 0) > EVAL_HISTORY_BYTE_LIMIT
      )
        throw new Error('F266 subject discovery budget exceeded');
      progress.cursor = cursor;
      progress.discovered = cursor === '0';
      progress.pending = subjects;
    }
    const subject = progress.pending[0] ?? (await redis.srandmember(keys.dirty)) ?? '';
    const keyList = [
      keys.progress,
      keys.lock,
      keys.dirty,
      subject ? ReevalClosureKeys.eventLog(subject) : '',
      subject ? keys.subjectSequence(subject) : '',
      keys.ownerCounts,
    ];
    const expectedSequence = subject ? Number((await redis.get(keys.subjectSequence(subject))) ?? 0) : 0;
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0)
      throw new Error('F266 invalid history progress');
    const raw = subject
      ? await redis.eval(
          CHUNK,
          1,
          keyList[3],
          String(expectedSequence),
          String(EVAL_HISTORY_EVENT_LIMIT),
          String(EVAL_HISTORY_BYTE_LIMIT),
        )
      : ['0'];
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string'))
      throw new Error('F266 invalid canonical event chunk');
    const size = Number(raw[0]);
    if (subject && size === 0) throw new Error('F266 canonical subject log missing');
    const grouped = new Map<string, Map<number, EvalLifecycleEvent>>();
    raw.slice(1).forEach((encoded, index) => {
      const event = EvalLifecycleEventSchema.parse(JSON.parse(encoded as string));
      if ((event.caseId ?? event.verdictId) !== subject) throw new Error('F266 event subject mismatch');
      if (event.type.startsWith('approval_') && 'proposalId' in event && typeof event.proposalId === 'string') {
        const events = grouped.get(event.proposalId) ?? new Map();
        events.set(expectedSequence + index, event);
        grouped.set(event.proposalId, events);
      }
    });
    const edits = [];
    for (const [proposalId, events] of grouped) {
      const read = await readEvalRepairHistoryRecord(redis, proposalId, { subject, events });
      if (!read) throw new Error('F266 history projection missing');
      const { record } = read;
      const subjectKey = keyList.push(keys.proposalSubject(proposalId));
      const eventsKey = keyList.push(keys.proposalEvents(proposalId));
      const ownerKey = keyList.push(keys.owner(record.proposal.requestOrigin.ownerUserId));
      const time = evalRepairHistoryTime(record);
      if (!Number.isSafeInteger(time) || time < 0) throw new Error('F266 invalid history time');
      edits.push({
        subjectKey,
        eventsKey,
        ownerKey,
        owner: record.proposal.requestOrigin.ownerUserId,
        proposalId,
        refs: [...events.keys()],
        time,
        visible: record.publication.state === 'anchored' && record.lifecycle.resolution !== 'open',
      });
    }
    const nextSequence = expectedSequence + raw.length - 1;
    if (progress.pending[0] === subject && nextSequence === size) progress.pending.shift();
    progress.complete = false;
    progress.batches++;
    progress.events += raw.length - 1;
    const committed = Number(
      await redis.eval(
        COMMIT,
        keyList.length,
        ...keyList,
        token,
        prior ?? '',
        JSON.stringify(progress),
        String(size),
        subject,
        String(nextSequence),
        JSON.stringify(edits),
      ),
    );
    if (committed === 0) return { ...checkpoint(progress), complete: false };
    return { ...checkpoint(progress), complete: committed === 2 };
  } finally {
    await redis.eval(RELEASE, 1, keys.lock, token);
  }
}
