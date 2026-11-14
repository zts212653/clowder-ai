import type { BallCustodyProjection } from '@cat-cafe/shared';
import { z } from 'zod';
import type { BallProbeRecoveryFacts } from './ball-probe-recovery-state.js';

const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = z.enum(['new', 'active', 'blocked', 'parked', 'dead', 'void', 'zombie', 'resolved']);
const disposition = z.enum(['needs_attention', 'settled']).optional();
const lane = z.object({
  scope: text,
  revision: count,
  failures: count,
  nextAt: count,
  disposition,
  reasonCode: text.optional(),
  intentAt: count.optional(),
});
const event = z.object({
  subjectKey: text,
  sourceEventId: text,
  kind: z.literal('ball.wake_sent'),
  classification: z.literal('informational'),
  at: count,
  payload: z.record(z.unknown()),
});
const audit = z.object({
  key: text,
  scope: text,
  messageId: text,
  event,
  failures: count,
  revision: count,
  nextAt: count,
  disposition,
});
const notice = z.object({
  key: text,
  lane: z.enum(['probe', 'idle']),
  scope: text,
  owner: z.object({ taskId: text, userId: text, threadId: text }),
  reasonCode: text,
  nextAt: count,
  failures: count,
  state: z.enum(['pending', 'delivered', 'owner_unavailable', 'needs_attention']),
});
const factsSchema = z.object({
  v: z.literal(1),
  subjectKey: text,
  generation: count,
  source: z.object({ state, episode: count.nullable(), lastEventAt: count, eventCount: count }).optional(),
  rebuilding: z.boolean().optional(),
  probe: lane.optional(),
  idle: lane.optional(),
  wakeReceipt: z
    .object({ scope: text, messageId: text, at: count, eventId: text, eventRecorded: z.boolean().optional() })
    .optional(),
  wakeAudits: z.record(audit).optional(),
  latestWakeAttention: text.optional(),
  notices: z.record(notice),
  noticeReceipts: z.object({ probe: text.optional(), idle: text.optional() }).optional(),
  disposition: z.literal('needs_attention').optional(),
  reasonCode: text.optional(),
  originalRaw: z.string().optional(),
});

/** Validate scheduling numbers and exact evidence bindings before any Lua publication can change business bytes. */
export function validBallRecoveryFacts(value: unknown, subject: string): value is BallProbeRecoveryFacts {
  const parsed = factsSchema.safeParse(value);
  if (!parsed.success || parsed.data.subjectKey !== subject) return false;
  return (
    Object.entries(parsed.data.wakeAudits ?? {}).every(
      ([key, entry]) => key === entry.key && key === entry.event.sourceEventId && entry.event.subjectKey === subject,
    ) &&
    Object.entries(parsed.data.notices).every(
      ([key, entry]) => key === entry.key && subject === `ball:task:${entry.owner.taskId}`,
    )
  );
}

const projectionSchema = z.object({
  subjectKey: text,
  state,
  lastEventAt: count,
  lastStateChangeAt: count,
  appliedEventCount: count,
  blockedSinceAt: count.nullable().optional(),
  lastWakeAt: count.nullable().optional(),
});
export function validBallRecoveryProjection(value: unknown, subject: string): value is BallCustodyProjection {
  const parsed = projectionSchema.safeParse(value);
  return parsed.success && parsed.data.subjectKey === subject;
}
