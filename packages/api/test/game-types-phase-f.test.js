import { describe, it, assert } from 'vitest';

describe('Phase F types', () => {
  describe('ActionStatus', () => {
    it('isValidActionStatus accepts valid statuses', async () => {
      const { isValidActionStatus } = await import('@cat-cafe/shared');
      assert.isTrue(isValidActionStatus('waiting'));
      assert.isTrue(isValidActionStatus('acting'));
      assert.isTrue(isValidActionStatus('acted'));
      assert.isTrue(isValidActionStatus('timed_out'));
      assert.isTrue(isValidActionStatus('fallback'));
    });

    it('isValidActionStatus rejects invalid statuses', async () => {
      const { isValidActionStatus } = await import('@cat-cafe/shared');
      assert.isFalse(isValidActionStatus('pending'));
      assert.isFalse(isValidActionStatus(''));
      assert.isFalse(isValidActionStatus(42));
      assert.isFalse(isValidActionStatus(null));
    });
  });

  describe('PendingAction', () => {
    it('has status and requestedAt fields', async () => {
      const { isValidActionStatus } = await import('@cat-cafe/shared');
      /** @type {import('@cat-cafe/shared').PendingAction} */
      const action = {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
        status: 'acted',
        requestedAt: Date.now() - 1000,
      };
      assert.isTrue(isValidActionStatus(action.status));
      assert.isNumber(action.requestedAt);
    });

    it('PendingAction with fallback has fallbackSource', async () => {
      /** @type {import('@cat-cafe/shared').PendingAction} */
      const action = {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
        status: 'fallback',
        requestedAt: Date.now() - 1000,
        fallbackSource: 'random',
      };
      assert.equal(action.fallbackSource, 'random');
      assert.equal(action.status, 'fallback');
    });
  });

  describe('Ballot', () => {
    it('has required fields', async () => {
      /** @type {import('@cat-cafe/shared').Ballot} */
      const ballot = {
        voterSeat: 'P1',
        choice: 'P3',
        revision: 1,
        locked: false,
        source: 'llm',
        submittedAt: Date.now(),
      };
      assert.equal(ballot.voterSeat, 'P1');
      assert.equal(ballot.revision, 1);
      assert.isFalse(ballot.locked);
    });

    it('choice can be null (abstain)', async () => {
      /** @type {import('@cat-cafe/shared').Ballot} */
      const ballot = {
        voterSeat: 'P2',
        choice: null,
        revision: 1,
        locked: true,
        source: 'fallback',
        submittedAt: Date.now(),
      };
      assert.isNull(ballot.choice);
      assert.isTrue(ballot.locked);
    });
  });

  describe('Resolution', () => {
    it('has required fields', async () => {
      /** @type {import('@cat-cafe/shared').Resolution} */
      const resolution = {
        winningChoice: 'P3',
        tiePolicy: 'no_kill',
        revoteCount: 0,
        fallbackApplied: false,
      };
      assert.equal(resolution.winningChoice, 'P3');
      assert.equal(resolution.tiePolicy, 'no_kill');
    });

    it('winningChoice is null on no_kill tie', async () => {
      /** @type {import('@cat-cafe/shared').Resolution} */
      const resolution = {
        winningChoice: null,
        tiePolicy: 'no_kill',
        revoteCount: 1,
        fallbackApplied: false,
      };
      assert.isNull(resolution.winningChoice);
      assert.equal(resolution.revoteCount, 1);
    });
  });

  describe('GameEvent revealPolicy', () => {
    it('accepts revealPolicy field', async () => {
      /** @type {import('@cat-cafe/shared').GameEvent} */
      const event = {
        eventId: 'e1',
        round: 1,
        phase: 'night_wolf',
        type: 'action.submitted',
        scope: 'god',
        payload: { seatId: 'P1', target: 'P3' },
        timestamp: Date.now(),
        revealPolicy: 'live',
      };
      assert.equal(event.revealPolicy, 'live');
    });
  });
});
