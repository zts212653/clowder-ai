import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { BallCustodyKeys } from './ball-custody-keys.js';
import { BallProbeRecoveryConflict } from './ball-probe-recovery-backend.js';

const COMPLETE = 'ballcustody:recovery:census:v2';
const CHECKPOINT = `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2]); return 1`;
const RESET = `
for i=2,#KEYS do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('invalid_ball_recovery_index') end
end
for i=2,#KEYS do redis.call('DEL', KEYS[i]) end
redis.call('SET', KEYS[1], ARGV[1]); return 1`;

interface Census {
  v: 1;
  generation: string;
  phase: 'projections' | 'metadata';
  cursor: string;
  page?: { next: string; subjects: string[]; offset: number };
}
const freshCensus = (): Census => ({ v: 1, generation: randomUUID(), phase: 'projections', cursor: '0' });

function decode(raw: string): Census {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('invalid_ball_recovery_census');
  const c = value as Record<string, unknown>;
  const p = c.page as Record<string, unknown> | undefined;
  if (
    c.v !== 1 ||
    typeof c.generation !== 'string' ||
    !['projections', 'metadata'].includes(String(c.phase)) ||
    typeof c.cursor !== 'string' ||
    !/^\d+$/.test(c.cursor) ||
    (p &&
      (typeof p.next !== 'string' ||
        !/^\d+$/.test(p.next) ||
        !Array.isArray(p.subjects) ||
        !p.subjects.every((s: unknown) => typeof s === 'string') ||
        !Number.isSafeInteger(p.offset) ||
        Number(p.offset) < 0 ||
        Number(p.offset) > p.subjects.length))
  )
    throw new Error('invalid_ball_recovery_census');
  return value as Census;
}

/** Resumable discovery in the original census marker; canonical subject facts still own all dispositions. */
export class BallProbeRecoveryCensus {
  constructor(
    private readonly redis: RedisClient,
    private readonly indexes: readonly string[],
    private readonly reconcile: (subject: string) => Promise<void>,
  ) {}

  async reset(): Promise<void> {
    await this.redis.eval(RESET, this.indexes.length + 1, COMPLETE, ...this.indexes, JSON.stringify(freshCensus()));
  }

  async advance(): Promise<boolean> {
    let raw = await this.redis.get(COMPLETE);
    if (raw === '1') return true;
    let state = raw === null ? freshCensus() : decode(raw);
    if (raw === null) {
      const initial = JSON.stringify(state);
      if (Number(await this.redis.eval(CHECKPOINT, 1, COMPLETE, '', initial)) !== 1) return false;
      raw = initial;
    }
    const checkpoint = async (next: Census | '1'): Promise<boolean> => {
      const encoded = next === '1' ? next : JSON.stringify(next);
      if (Number(await this.redis.eval(CHECKPOINT, 1, COMPLETE, raw ?? '', encoded)) !== 1) return false;
      raw = encoded;
      return true;
    };
    const started = performance.now();
    let visited = 0,
      pages = 0;
    // Leave headroom inside the caller's five-second observation scope. The I/O fence also
    // prevents an interrupted continuation from advancing a later census or doing late work.
    while (visited < 1000 && pages < 16 && performance.now() - started < 2500) {
      if (!state.page) {
        const prefix = `${this.redis.options.keyPrefix ?? ''}ballcustody:events:meta:`;
        const [next, selected] =
          state.phase === 'projections'
            ? await this.redis.sscan(BallCustodyKeys.projectionsIndex, state.cursor, 'COUNT', 100)
            : await this.redis.scan(state.cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        pages++;
        state = {
          ...state,
          page: {
            next,
            offset: 0,
            subjects: state.phase === 'projections' ? selected : selected.map((key) => key.slice(prefix.length)),
          },
        };
      } else if (state.page.offset < state.page.subjects.length) {
        try {
          await this.reconcile(state.page.subjects[state.page.offset]!);
        } catch (error) {
          if (error instanceof BallProbeRecoveryConflict) return false;
          throw error;
        }
        visited++;
        state = { ...state, page: { ...state.page, offset: state.page.offset + 1 } };
      } else if (state.page.next !== '0') {
        state = { ...state, cursor: state.page.next, page: undefined };
      } else if (state.phase === 'projections') {
        state = { ...state, phase: 'metadata', cursor: '0', page: undefined };
      } else {
        return checkpoint('1');
      }
      if (!(await checkpoint(state))) return false;
    }
    return false;
  }
}
