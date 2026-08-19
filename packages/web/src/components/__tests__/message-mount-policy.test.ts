import { describe, expect, it } from 'vitest';
import { EAGER_MESSAGE_TAIL_COUNT, messageMountPolicy } from '../message-mount-policy';

describe('messageMountPolicy', () => {
  it('renders only the newest eight messages in the thread-switch critical path', () => {
    const policies = Array.from({ length: 50 }, (_, index) => messageMountPolicy(index, 50));

    expect(policies.filter((policy) => policy.eager)).toHaveLength(EAGER_MESSAGE_TAIL_COUNT);
    expect(policies.slice(-EAGER_MESSAGE_TAIL_COUNT).every((policy) => policy.eager)).toBe(true);
    expect(policies.slice(0, -EAGER_MESSAGE_TAIL_COUNT).every((policy) => !policy.eager)).toBe(true);
  });

  it('stagger-mounts older messages instead of scheduling one full-list burst', () => {
    const nearestDeferred = messageMountPolicy(41, 50);
    const oldestDeferred = messageMountPolicy(0, 50);

    expect(nearestDeferred.backgroundMountDelayMs).toBeGreaterThan(0);
    expect(oldestDeferred.backgroundMountDelayMs).toBeGreaterThan(nearestDeferred.backgroundMountDelayMs ?? 0);
  });
});
