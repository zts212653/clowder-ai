import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventEmitterActionNotifier } from '../dist/domains/cats/services/game/EventEmitterActionNotifier.js';

describe('EventEmitterActionNotifier', () => {
  it('waitForAction resolves true when onActionReceived fires before timeout', async () => {
    const notifier = new EventEmitterActionNotifier();
    const promise = notifier.waitForAction('game-1', 'P1', 5000);
    notifier.onActionReceived('game-1', 'P1');
    const result = await promise;
    assert.equal(result, true);
  });

  it('waitForAction resolves false on timeout', async () => {
    const notifier = new EventEmitterActionNotifier();
    const result = await notifier.waitForAction('game-1', 'P1', 50);
    assert.equal(result, false);
  });

  it('waitForAction is scoped by gameId and seatId', async () => {
    const notifier = new EventEmitterActionNotifier();
    const promise = notifier.waitForAction('game-1', 'P1', 100);
    notifier.onActionReceived('game-1', 'P2');
    const result = await promise;
    assert.equal(result, false);
  });

  it('waitForAllActions resolves when all seats receive actions', async () => {
    const notifier = new EventEmitterActionNotifier();
    const promise = notifier.waitForAllActions('game-1', ['P1', 'P2', 'P3'], 5000);
    notifier.onActionReceived('game-1', 'P2');
    notifier.onActionReceived('game-1', 'P1');
    notifier.onActionReceived('game-1', 'P3');
    await promise;
  });

  it('waitForAllActions resolves even if some seats time out', async () => {
    const notifier = new EventEmitterActionNotifier();
    const start = Date.now();
    const promise = notifier.waitForAllActions('game-1', ['P1', 'P2'], 100);
    notifier.onActionReceived('game-1', 'P1');
    await promise;
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 80, `expected ~100ms timeout for P2, got ${elapsed}ms`);
  });

  it('cleanup unblocks dangling waiters', async () => {
    const notifier = new EventEmitterActionNotifier();
    const promise = notifier.waitForAction('game-1', 'P3', 10_000);
    notifier.cleanup('game-1');
    const result = await promise;
    assert.equal(result, true);
  });

  it('multiple games are independent', async () => {
    const notifier = new EventEmitterActionNotifier();
    const p1 = notifier.waitForAction('game-A', 'P1', 100);
    const p2 = notifier.waitForAction('game-B', 'P1', 5000);
    notifier.onActionReceived('game-B', 'P1');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, false);
    assert.equal(r2, true);
  });
});
