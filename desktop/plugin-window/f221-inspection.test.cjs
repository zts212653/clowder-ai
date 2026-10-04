const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectF221 } = require('./f221-inspection.cjs');

const digest = 'a'.repeat(64);
const snapshot = (overrides = {}) => ({
  kind: 'f221-preview',
  snapshot: {
    proposalId: '11111111-1111-4111-8111-111111111111',
    ownerUserId: 'owner',
    digest,
    nonce: 'b'.repeat(48),
    expiresAt: 121000,
    fields: {
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'owner',
      scene: '一起看设计稿',
      quote: '保留一点呼吸感',
      takeaway: '重要的是留白',
      dimension: 'visual-quality',
      tags: '["留白"]',
      privacy: 'sensitive',
      publication: JSON.stringify({ state: 'anchored' }),
    },
    ...overrides,
  },
});

test('Host native button returns a trial receipt only after a complete recap and unchanged exact digest', async () => {
  let reads = 0,
    shown,
    confirmed;
  const result = await inspectF221({
    dialog: {
      showMessageBox: async (_win, options) => {
        shown = options;
        return { response: 1 };
      },
    },
    win: {},
    current: () => true,
    now: () => 1000,
    read: async () => {
      reads++;
      return snapshot();
    },
    confirm: async (nonce, action) => {
      confirmed = { nonce, action };
      return {
        kind: 'f221-trial-receipt',
        nonce,
        action,
        proposalId: snapshot().snapshot.proposalId,
        digest,
        origin: 'host-native-dialog',
        confirmedAt: 1000,
      };
    },
  });
  assert.deepEqual(result, { kind: 'decision-trial', status: 'trial_confirmed' });
  assert.equal(reads, 1);
  assert.deepEqual(confirmed, { nonce: 'b'.repeat(48), action: 'approve' });
  assert.match(shown.detail, /一起看设计稿/);
  assert.match(shown.detail, /保留一点呼吸感/);
  assert.match(shown.detail, /重要的是留白/);
  assert.match(shown.detail, /维度：视觉品质/);
  assert.match(shown.detail, /敏感/);
  assert.match(shown.detail, /不会提交/);
  assert.match(shown.buttons[1], /批准演练/);
  assert.match(shown.buttons[2], /拒绝演练/);
});

test('reject trial preserves the action in the private receipt and never sends it to the package', async () => {
  let action;
  const result = await inspectF221({
    dialog: { showMessageBox: async () => ({ response: 2 }) },
    win: {},
    current: () => true,
    now: () => 1000,
    read: async () => snapshot(),
    confirm: async (nonce, selected) => {
      action = selected;
      return {
        kind: 'f221-trial-receipt',
        nonce,
        action: selected,
        proposalId: snapshot().snapshot.proposalId,
        digest,
        origin: 'host-native-dialog',
        confirmedAt: 1000,
      };
    },
  });
  assert.equal(action, 'reject');
  assert.deepEqual(result, { kind: 'decision-trial', status: 'trial_confirmed' });
});

test('interrupted recap, changed content, and expired window cannot confirm even the trial', async () => {
  const base = { win: {}, current: () => true, now: () => 1000 };
  const dismissed = await inspectF221({
    ...base,
    read: async () => snapshot(),
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  });
  assert.equal(dismissed.status, 'dismissed');
  let confirmed = 0;
  const changed = await inspectF221({
    ...base,
    read: async () => snapshot(),
    confirm: async () => {
      confirmed++;
      return { kind: 'decision-trial', status: 'stale' };
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
  });
  assert.equal(changed.status, 'stale');
  assert.equal(confirmed, 1);
  let clock = 1000;
  const expired = await inspectF221({
    ...base,
    now: () => clock,
    read: async () => snapshot(),
    confirm: async () => {
      throw new Error('expired dialog must not confirm');
    },
    dialog: {
      showMessageBox: async () => {
        clock += 120001;
        return { response: 1 };
      },
    },
  });
  assert.equal(expired.status, 'stale');
  let uninterrupted = true;
  const interrupted = await inspectF221({
    ...base,
    current: () => uninterrupted,
    read: async () => snapshot(),
    confirm: async () => {
      throw new Error('interrupted dialog must not confirm');
    },
    dialog: {
      showMessageBox: async () => {
        uninterrupted = false;
        return { response: 1 };
      },
    },
  });
  assert.equal(interrupted.status, 'stale');
  const unanchored = await inspectF221({
    ...base,
    read: async () => snapshot({ fields: { ...snapshot().snapshot.fields, publication: '{}' } }),
    dialog: {
      showMessageBox: async () => {
        throw new Error('must not show');
      },
    },
  });
  assert.equal(unanchored.status, 'unavailable');
  const tooLong = await inspectF221({
    ...base,
    read: async () => snapshot({ fields: { ...snapshot().snapshot.fields, quote: '字'.repeat(1801) } }),
    dialog: {
      showMessageBox: async () => {
        throw new Error('must not hide a long recap');
      },
    },
  });
  assert.equal(tooLong.status, 'unavailable');
  const tooLongTakeaway = await inspectF221({
    ...base,
    read: async () => snapshot({ fields: { ...snapshot().snapshot.fields, takeaway: '字'.repeat(1801) } }),
    dialog: {
      showMessageBox: async () => {
        throw new Error('must not hide a long takeaway');
      },
    },
  });
  assert.equal(tooLongTakeaway.status, 'unavailable');
  const tooLongDimension = await inspectF221({
    ...base,
    read: async () => snapshot({ fields: { ...snapshot().snapshot.fields, dimension: '字'.repeat(1801) } }),
    dialog: {
      showMessageBox: async () => {
        throw new Error('must not show an unbounded dimension');
      },
    },
  });
  assert.equal(tooLongDimension.status, 'unavailable');
});
