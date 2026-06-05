/**
 * #699: isEligibleReplyParent — unified parent eligibility predicate
 * Ensures cursor-gap fetched parents and callback replyTo validation
 * use the same complete predicate chain.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { isEligibleReplyParent, canQuoteInPublicReply, resolveVisibleReplyParent } = await import(
  '../dist/domains/cats/services/stores/visibility.js'
);

/** Helper: minimal StoredMessage-like object */
function mockMsg(overrides) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'test',
    mentions: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

const catViewer = { type: 'cat', catId: 'opus' };
const defaultOpts = { threadId: 'thread-1', viewer: catViewer };

describe('#699: isEligibleReplyParent', () => {
  test('accepts a normal delivered message in same thread', () => {
    const parent = mockMsg({ deliveryStatus: 'delivered' });
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('accepts message with no deliveryStatus (legacy = delivered)', () => {
    const parent = mockMsg({});
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects queued parent', () => {
    const parent = mockMsg({ deliveryStatus: 'queued' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects canceled parent', () => {
    const parent = mockMsg({ deliveryStatus: 'canceled' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects deleted parent', () => {
    const parent = mockMsg({ deletedAt: Date.now() });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects system-user parent', () => {
    const parent = mockMsg({ userId: 'system', catId: null });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects briefing parent', () => {
    const parent = mockMsg({ origin: 'briefing' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects cross-thread parent', () => {
    const parent = mockMsg({ threadId: 'other-thread' });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects unrevealed whisper invisible to viewer cat', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['codex'], // opus is NOT a recipient
    });
    assert.ok(!isEligibleReplyParent(parent, defaultOpts));
  });

  test('accepts whisper visible to viewer cat', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['opus'], // opus IS a recipient
    });
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('accepts revealed whisper (visible to all)', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['codex'],
      revealedAt: Date.now(),
    });
    assert.ok(isEligibleReplyParent(parent, defaultOpts));
  });

  test('rejects other-cat stream message when hideOtherCatStreams=true', () => {
    const parent = mockMsg({ catId: 'codex', origin: 'stream' });
    assert.ok(!isEligibleReplyParent(parent, { ...defaultOpts, hideOtherCatStreams: true }));
  });

  test('accepts other-cat stream message when hideOtherCatStreams=false', () => {
    const parent = mockMsg({ catId: 'codex', origin: 'stream' });
    assert.ok(isEligibleReplyParent(parent, { ...defaultOpts, hideOtherCatStreams: false }));
  });

  test('user viewer sees all whispers', () => {
    const parent = mockMsg({
      visibility: 'whisper',
      whisperTo: ['codex'],
    });
    const userOpts = { threadId: 'thread-1', viewer: { type: 'user' } };
    assert.ok(isEligibleReplyParent(parent, userOpts));
  });
});

describe('#699: canQuoteInPublicReply', () => {
  test('allows quoting a normal public message', () => {
    const parent = mockMsg({});
    assert.ok(canQuoteInPublicReply(parent));
  });

  test('blocks quoting an unrevealed whisper', () => {
    const parent = mockMsg({ visibility: 'whisper', whisperTo: ['opus'] });
    assert.ok(!canQuoteInPublicReply(parent), 'unrevealed whisper must not be quoted in public reply');
  });

  test('allows quoting a revealed whisper', () => {
    const parent = mockMsg({ visibility: 'whisper', whisperTo: ['opus'], revealedAt: Date.now() });
    assert.ok(canQuoteInPublicReply(parent), 'revealed whisper is visible to all, safe to quote');
  });

  test('allows quoting a message with explicit public visibility', () => {
    const parent = mockMsg({ visibility: 'public' });
    assert.ok(canQuoteInPublicReply(parent));
  });
});

describe('#699: resolveVisibleReplyParent (atomic resolver)', () => {
  /** Minimal mock store */
  function mockStore(messages) {
    const map = new Map(messages.map((m) => [m.id, m]));
    return { getById: (id) => map.get(id) ?? null };
  }

  test('returns message when eligible', async () => {
    const parent = mockMsg({ id: 'p1', deliveryStatus: 'delivered' });
    const store = mockStore([parent]);
    const result = await resolveVisibleReplyParent(store, 'p1', defaultOpts);
    assert.ok(result);
    assert.equal(result.id, 'p1');
  });

  test('returns null for non-existent ID', async () => {
    const store = mockStore([]);
    const result = await resolveVisibleReplyParent(store, 'nope', defaultOpts);
    assert.equal(result, null);
  });

  test('returns null for ineligible parent (system user)', async () => {
    const parent = mockMsg({ id: 'p-sys', userId: 'system', catId: null });
    const store = mockStore([parent]);
    const result = await resolveVisibleReplyParent(store, 'p-sys', defaultOpts);
    assert.equal(result, null);
  });

  test('returns null for unrevealed whisper in public reply', async () => {
    const parent = mockMsg({ id: 'p-w', visibility: 'whisper', whisperTo: ['opus'] });
    const store = mockStore([parent]);
    // Without publicReply — eligible (sender can see)
    const eligible = await resolveVisibleReplyParent(store, 'p-w', defaultOpts);
    assert.ok(eligible, 'whisper visible to sender should pass without publicReply');
    // With publicReply — blocked
    const blocked = await resolveVisibleReplyParent(store, 'p-w', { ...defaultOpts, publicReply: true });
    assert.equal(blocked, null, 'unrevealed whisper must be blocked for public reply');
  });

  test('allows revealed whisper in public reply', async () => {
    const parent = mockMsg({ id: 'p-rw', visibility: 'whisper', whisperTo: ['codex'], revealedAt: Date.now() });
    const store = mockStore([parent]);
    const result = await resolveVisibleReplyParent(store, 'p-rw', { ...defaultOpts, publicReply: true });
    assert.ok(result, 'revealed whisper should pass even for public reply');
  });
});
