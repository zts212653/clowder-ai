/**
 * `isLifecycleStoredMessageMetadata` is the fail-closed boundary for lifecycle metadata recovered
 * from Redis rows and websocket frames — `RedisMessageStore`, `redis-message-parsers` and
 * `useSocket` all gate on it. Two of its literal checks were written as
 * `[...].includes(String(candidate.x))`, which only looks fail-closed: `String(['completed'])` is
 * `'completed'`, so a one-element array walks straight through a guard whose whole job is to
 * reject it. Downstream the value is neither `'processing'` nor a valid terminal literal, so
 * projections can be suppressed and a terminal commit can conflict permanently.
 *
 * Both call sites are pinned here, not just the reported one — they are the same defect, and
 * fixing only the reported instance leaves the identical hole one branch away.
 */
import { describe, expect, it } from 'vitest';
import { isLifecycleStoredMessageMetadata } from '../types/message-lifecycle.js';

const response = (over: Record<string, unknown> = {}) => ({
  orderKey: '0001789000000000-000001-aaaaaaaa',
  kind: 'response',
  invocationId: 'inv-1',
  targetId: 'cat-1',
  inputEntryIds: ['queue:1'],
  inputMessageIds: ['msg-1'],
  status: 'completed',
  startedAt: 1789000000000,
  completedAt: 1789000000001,
  ...over,
});

const deliveryFailure = (over: Record<string, unknown> = {}) => ({
  orderKey: '0001789000000000-000002-bbbbbbbb',
  kind: 'delivery_failure',
  status: 'failed',
  sourceEntryId: 'queue:2',
  inputMessageId: 'msg-2',
  requestedTargets: ['cat-1'],
  reason: 'prestart_timeout',
  createdAt: 1789000000000,
  ...over,
});

describe('isLifecycleStoredMessageMetadata — literal membership must not coerce', () => {
  it('accepts a well-formed response', () => {
    expect(isLifecycleStoredMessageMetadata(response())).toBe(true);
  });

  it('accepts a well-formed delivery failure', () => {
    expect(isLifecycleStoredMessageMetadata(deliveryFailure())).toBe(true);
  });

  it('rejects a response whose status is a one-element array', () => {
    expect(isLifecycleStoredMessageMetadata(response({ status: ['completed'] }))).toBe(false);
  });

  it('rejects a delivery failure whose reason is a one-element array', () => {
    expect(isLifecycleStoredMessageMetadata(deliveryFailure({ reason: ['prestart_timeout'] }))).toBe(false);
  });

  it('rejects a response whose status is an object that stringifies to a literal', () => {
    const status = { toString: () => 'processing' };
    expect(isLifecycleStoredMessageMetadata(response({ status }))).toBe(false);
  });

  it('still rejects a plainly wrong status literal', () => {
    expect(isLifecycleStoredMessageMetadata(response({ status: 'nonsense' }))).toBe(false);
  });
});
