import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

for (const phase of ['selection', 'reconciliation', 'claim', 'source']) {
  test(`#2008 repeated ${phase} failure holds its targets without stranding another member`, async (t) => {
    const h = await stopFixture(t, {
      idle: true,
      retryDeferral: { baseDelayMs: 20 },
      routes: {
        threadStore: { get: async (id) => ({ id, createdBy: 'owner', participants: ['opus', 'codex', 'sonnet'] }) },
      },
    });
    const blocked = await h.send('blocked multi-target', ['opus', 'codex']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.send('independent target', ['sonnet']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.send('later same target', ['opus']);
    assert.equal(h.queue.listPendingAcrossUsers('thread')[0].id, blocked.entry.id);
    const failure = new Error(`temporary ${phase} failure`);
    let failures = 0;
    let faultEnabled = true;
    t.after(() => {
      faultEnabled = false;
    });
    let inspecting = phase === 'source';
    if (phase === 'selection' || phase === 'reconciliation') {
      const method =
        phase === 'selection' ? 'firstTargetWithExistingReceiver' : 'reconcileClaimedGroupWithExistingReceiver';
      const inspect = h.processor[method].bind(h.processor);
      h.processor[method] = async (...args) => {
        inspecting = args[0].some((entry) => entry.id === blocked.entry.id);
        try {
          return await inspect(...args);
        } finally {
          inspecting = false;
        }
      };
    }
    const read = h.messages.getById.bind(h.messages);
    h.messages.getById = (id) => {
      if (faultEnabled && inspecting && id === blocked.message.id) {
        failures += 1;
        throw failure;
      }
      return read(id);
    };
    const claim = h.ledger.claimPrefix.bind(h.ledger);
    h.ledger.claimPrefix = async (...args) => {
      if (faultEnabled && phase === 'claim' && args[1].includes(blocked.entry.id)) {
        failures += 1;
        throw failure;
      }
      return claim(...args);
    };
    if (phase === 'source') await h.processor.requestDrain('thread');
    else await assert.rejects(h.processor.requestDrain('thread'), (error) => error === failure);
    await waitFor(() => failures >= 3);
    assert.equal(faultEnabled, true);
    assert.ok(h.starts.includes('independent target'), 'independent work needs no manual wake during repeated failure');
    assert.equal(h.starts.includes('later same target'), false, "the failed source retains each target's order");
    assert.equal((await h.queue.getDurableEntry('thread', blocked.entry.id)).status, 'queued');
    faultEnabled = false;
    await waitFor(() => h.starts.includes('later same target') && !h.processor.isThreadBusy('thread'));
    assert.ok(h.starts.indexOf('blocked multi-target') < h.starts.indexOf('later same target'));
    assert.equal(await h.queue.getDurableEntry('thread', blocked.entry.id), null);
  });
}

for (const phase of ['failure-history', 'source']) {
  test(`#2008 targetless ${phase} failure remains a barrier until its recipients are known`, async (t) => {
    const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 20 } });
    h.processor.deps.router.resolveConversationTargetsAtAdmission = async () => ['opus'];
    const blocked = await h.send('unknown target', []);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.send('later explicit target', ['codex']);
    assert.equal(h.queue.listPendingAcrossUsers('thread')[0].id, blocked.entry.id);
    const failure = new Error('targetless admission read unavailable');
    let failures = 0;
    let faultEnabled = true;
    t.after(() => {
      faultEnabled = false;
    });
    const history = h.messages.getByIdempotencyKey.bind(h.messages);
    h.messages.getByIdempotencyKey = (...args) => {
      if (faultEnabled && phase === 'failure-history' && args[2].includes(blocked.entry.id)) {
        failures += 1;
        throw failure;
      }
      return history(...args);
    };
    const read = h.messages.getById.bind(h.messages);
    h.messages.getById = (id) => {
      if (faultEnabled && phase === 'source' && id === blocked.message.id) {
        failures += 1;
        throw failure;
      }
      return read(id);
    };
    if (phase === 'source') await h.processor.requestDrain('thread');
    else await assert.rejects(h.processor.requestDrain('thread'), (error) => error === failure);
    await waitFor(() => failures >= 3);
    assert.deepEqual(h.starts, [], 'unknown recipients must block every later source throughout retries');
    faultEnabled = false;
    await waitFor(() => h.starts.includes('later explicit target') && !h.processor.isThreadBusy('thread'));
    assert.deepEqual(h.starts, ['unknown target', 'later explicit target']);
  });
}
