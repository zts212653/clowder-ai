import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '../dist/domains/cats/services/session/SessionManager.js';
import { isHomeSession, watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';

const identity = { userId: 'owner', threadId: 'thread', catId: 'codex61-sol' };

test('watcher sequence allocation and retention do not consume home chain ordinals', async () => {
  const sessions = new SessionChainStore();
  const home = await sessions.create(identity);
  const watcher = await sessions.create({
    ...identity,
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey('owner', 'codex61-sol', 'thread'),
  });
  const nextHome = await sessions.create(identity);
  assert.equal(home.seq, 0);
  assert.equal(watcher.seq, 0);
  assert.equal(nextHome.seq, 1);
  // Eviction must recognize the purpose-specific active index too.
  assert.equal(sessions.evictOne(), true);
  assert.ok(await sessions.get(watcher.id));
  assert.ok(await sessions.get(nextHome.id));
  assert.equal(await sessions.get(home.id), null);
});

test('watching does not replace the work member context epoch or make its next resume cold', async () => {
  const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/context/ContextEpochOwner.js');
  const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');
  const epochs = new ContextEpochOwner(new InMemoryContextEpochStore());
  const work = await epochs.resolve({
    ...identity,
    disposition: {
      state: 'fresh',
      reason: 'no_prior_session',
      runtimeSessionId: 'work-native',
      evidenceRef: 'work-start',
    },
  });
  await epochs.confirmColdConsumed({ ...identity, contextEpoch: work.contextEpoch });
  await epochs.resolve({
    ...identity,
    sessionPurpose: 'watcher',
    disposition: {
      state: 'fresh',
      reason: 'no_prior_session',
      runtimeSessionId: 'watcher-native',
      evidenceRef: 'watcher-start',
    },
  });
  const next = await epochs.resolve({
    ...identity,
    disposition: {
      state: 'resumed',
      reason: 'resume_confirmed',
      runtimeSessionId: 'work-native',
      evidenceRef: 'work-resume',
    },
  });
  assert.equal(next.contextMode, 'hot');
  assert.equal(next.boundRuntimeSessionId, 'work-native');
  assert.equal(next.contextEpoch, work.contextEpoch);
});

test('one member retains separate native resume pointers for work and watcher roles', async () => {
  const manager = new SessionManager();
  await manager.store('owner', 'codex61-sol', 'thread', 'work-native');
  await manager.store('owner', 'codex61-sol', 'thread', 'watcher-native', 'watcher');
  assert.equal(await manager.get('owner', 'codex61-sol', 'thread'), 'work-native');
  assert.equal(await manager.get('owner', 'codex61-sol', 'thread', 'watcher'), 'watcher-native');
  await manager.delete('owner', 'codex61-sol', 'thread', 'watcher');
  assert.equal(await manager.get('owner', 'codex61-sol', 'thread'), 'work-native');
});

test('creating and resuming a watcher never replaces or seals the work home chain', async () => {
  const sessions = new SessionChainStore();
  const home = await sessions.create({ ...identity, cliSessionId: 'work-native' });
  const watcher = await sessions.getOrCreateActive({
    ...identity,
    sessionPurpose: 'watcher',
    cliSessionId: 'watcher-native',
    chainKey: watcherSessionChainKey('owner', 'codex61-sol', 'thread'),
  });
  assert.notEqual(watcher.id, home.id);
  assert.equal(isHomeSession(watcher), false);
  assert.equal((await sessions.getActive('codex61-sol', 'thread', 'owner')).id, home.id);
  assert.equal((await sessions.get(home.id)).status, 'active');
  await sessions.update(watcher.id, { status: 'active' });
  assert.equal((await sessions.getActive('codex61-sol', 'thread', 'owner')).id, home.id);
  assert.equal(
    (await sessions.getOrCreateActive({ ...identity, sessionPurpose: 'watcher', chainKey: watcher.chainKey })).id,
    watcher.id,
  );
});
