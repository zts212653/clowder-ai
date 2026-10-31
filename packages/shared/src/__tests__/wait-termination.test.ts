import { describe, expect, it } from 'vitest';
import { userCancelWaitTerminationEventSchema, waitTerminationEventSchema } from '../types/wait-termination.js';

const event = {
  v: 1,
  eventId: 'wait-termination:hold_ball:hold-ball-123:user_cancel',
  kind: 'wait.terminated',
  waitId: 'hold-ball-123',
  waitKind: 'hold_ball',
  generation: 1,
  subjectRef: 'wait:hold_ball:hold-ball-123',
  threadId: 'thread-1',
  ownerUserId: 'owner-1',
  ownerCatId: 'codex-sol',
  reason: 'user_cancel',
  actor: { kind: 'user', userId: 'owner-1' },
  at: 123,
} as const;

describe('F280 wait termination contract', () => {
  it('accepts the canonical owner-authenticated user-cancel event', () => {
    expect(userCancelWaitTerminationEventSchema.parse(event)).toEqual(event);
    expect(waitTerminationEventSchema.parse(event)).toEqual(event);
  });

  it('keeps explanatory feedback out of the F280 termination event', () => {
    expect(
      userCancelWaitTerminationEventSchema.safeParse({
        ...event,
        feedback: { reasonCode: 'wrong' },
      }).success,
    ).toBe(false);
  });

  it('rejects a user-cancel event whose actor is not the authenticated owner', () => {
    expect(
      userCancelWaitTerminationEventSchema.safeParse({
        ...event,
        actor: { kind: 'user', userId: 'someone-else' },
      }).success,
    ).toBe(false);
  });
});
