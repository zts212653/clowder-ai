/**
 * F208 Phase D: DossierObservationStore — operator 观察的 staging 层。
 *
 * AC-D1: 画像页"添加观察"按钮，operator 写观察 + provenance，存到 dossier pending 层。
 * OQ-10: Phase D = staging + read，promotion 留 Phase E。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('DossierObservationStore (in-memory)', () => {
  let store;

  beforeEach(async () => {
    const { InMemoryDossierObservationStore } = await import(
      '../dist/domains/cats/services/stores/ports/DossierObservationStore.js'
    );
    store = new InMemoryDossierObservationStore();
  });

  const baseInput = (over = {}) => ({
    catId: 'opus',
    content: 'opus 在 F208 review 中连续 3 轮没发现 formatModelName 的 bug',
    author: 'you',
    ...over,
  });

  // --- add ---

  it('add → returns observation with id, provenance, and createdAt', () => {
    const obs = store.add(baseInput());
    assert.ok(obs.id, 'should generate an id');
    assert.match(obs.id, /^obs_/, 'id should have obs_ prefix');
    assert.equal(obs.catId, 'opus');
    assert.equal(obs.content, 'opus 在 F208 review 中连续 3 轮没发现 formatModelName 的 bug');
    assert.equal(obs.provenance.type, 'cvo');
    assert.equal(obs.provenance.author, 'you');
    assert.ok(obs.provenance.date, 'provenance should have a date');
    assert.ok(obs.createdAt > 0, 'should have createdAt timestamp');
  });

  it('add → returned observation is a detached copy (mutation safety)', () => {
    const obs = store.add(baseInput());
    obs.content = 'MUTATED';
    const stored = store.get(obs.id);
    assert.notEqual(stored.content, 'MUTATED', 'store should not be affected by external mutation');
  });

  // --- list ---

  it('list → returns observations for a specific cat, sorted newest first', () => {
    store.add(baseInput({ content: 'first observation' }));
    store.add(baseInput({ content: 'second observation' }));
    store.add(baseInput({ catId: 'codex', content: 'different cat' }));

    const list = store.list('opus');
    assert.equal(list.length, 2, 'should only return opus observations');
    assert.equal(list[0].content, 'second observation', 'newest first');
    assert.equal(list[1].content, 'first observation');
  });

  it('list → respects limit parameter', () => {
    store.add(baseInput({ content: 'a' }));
    store.add(baseInput({ content: 'b' }));
    store.add(baseInput({ content: 'c' }));

    const list = store.list('opus', 2);
    assert.equal(list.length, 2);
  });

  it('list → returns empty array for cat with no observations', () => {
    const list = store.list('nonexistent-cat');
    assert.deepEqual(list, []);
  });

  // --- listAll ---

  it('listAll → returns observations grouped by catId', () => {
    store.add(baseInput({ catId: 'opus', content: 'opus obs 1' }));
    store.add(baseInput({ catId: 'opus', content: 'opus obs 2' }));
    store.add(baseInput({ catId: 'codex', content: 'codex obs' }));

    const all = store.listAll();
    assert.ok(all.opus, 'should have opus group');
    assert.ok(all.codex, 'should have codex group');
    assert.equal(all.opus.length, 2);
    assert.equal(all.codex.length, 1);
  });

  it('listAll → each group sorted newest first', () => {
    store.add(baseInput({ catId: 'opus', content: 'older' }));
    store.add(baseInput({ catId: 'opus', content: 'newer' }));

    const all = store.listAll();
    assert.equal(all.opus[0].content, 'newer');
    assert.equal(all.opus[1].content, 'older');
  });

  it('listAll → returns empty object when no observations', () => {
    const all = store.listAll();
    assert.deepEqual(all, {});
  });

  // --- get ---

  it('get → returns observation by id', () => {
    const obs = store.add(baseInput());
    const found = store.get(obs.id);
    assert.deepEqual(found, obs);
  });

  it('get → returns null for unknown id', () => {
    assert.equal(store.get('obs_nonexistent'), null);
  });

  // --- delete ---

  it('delete → removes observation and returns true', () => {
    const obs = store.add(baseInput());
    assert.equal(store.delete(obs.id), true);
    assert.equal(store.get(obs.id), null);
    assert.equal(store.list('opus').length, 0);
  });

  it('delete → returns false for unknown id', () => {
    assert.equal(store.delete('obs_nonexistent'), false);
  });
});
