import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { findWindowsLiveOwner } from '../dist/domains/cats/services/agents/invocation/WindowsJobStopRecovery.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import {
  clearWindowsJobExecutionLink,
  recordWindowsJobExecutionLink,
  resolveWindowsJobLinksDirectory,
} from '../dist/utils/windows-job-execution-links.js';
import { resolveWindowsJobDirectory, windowsControllerKey } from '../dist/utils/windows-job-owner.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

[
  { name: 'finished teardown and cleared links', terminal: true, teardown: true, clearLink: true, blocked: false },
  { name: 'running writer', terminal: false, teardown: false, clearLink: false, blocked: true },
  { name: 'terminal without teardown proof', terminal: true, teardown: false, clearLink: false, blocked: true },
  { name: 'terminal with a remaining owner link', terminal: true, teardown: true, clearLink: false, blocked: true },
  { name: 'unreadable links', terminal: true, teardown: true, clearLink: true, unreadableLinks: true, blocked: true },
].forEach(({ name, terminal, teardown, clearLink, unreadableLinks, blocked }) => {
  test(`#2008 owner query refresh: ${name}`, async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'issue2008-owner-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const jobName = `Local${String.fromCharCode(92)}ClowderProviderJob-issue2008`;
    const controller = { pid: 4321, createdAt: '2026-11-16T08:00:00.0000000Z' };
    mkdirSync(resolveWindowsJobDirectory(dataDir), { recursive: true });
    writeFileSync(
      join(resolveWindowsJobDirectory(dataDir), 'owner.json'),
      JSON.stringify({ v: 1, jobName, apiPid: 4322, helperPid: 4323, sessionId: 1, createdAt: 1, controller }),
    );
    const store = new InMemoryTurnExecutionStore();
    store.createRunning({
      invocationId: 'old-turn',
      parentInvocationId: 'old-parent',
      threadId: 'thread',
      userId: 'owner',
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: 1,
      providerLifecycleTracked: true,
    });
    store.markProviderStarted('old-turn', 2);
    const link = recordWindowsJobExecutionLink({
      dataDir,
      jobName,
      execution: {
        invocationId: 'old-turn',
        executionId: 'old-parent',
        threadId: 'thread',
        userId: 'owner',
        catId: 'codex',
      },
    });
    let queryEntered;
    const entered = new Promise((resolve) => {
      queryEntered = resolve;
    });
    let releaseQuery;
    const queryGate = new Promise((resolve) => {
      releaseQuery = resolve;
    });
    t.after(() => releaseQuery());
    let queryCount = 0;
    const probing = findWindowsLiveOwner({
      records: store.listRunningByUser('owner'),
      store,
      dataDir,
      execute: async () => {
        if (queryCount++ === 0)
          return { stdout: JSON.stringify({ state: 'absent', nativeError: 2, sessionId: 1 }), stderr: '' };
        queryEntered();
        await queryGate;
        return {
          stdout: JSON.stringify({ sessionId: 1, verdicts: { [windowsControllerKey(controller)]: 'alive' } }),
          stderr: '',
        };
      },
    });
    await entered;
    if (teardown) store.recordProviderTeardown('old-turn', 3);
    if (terminal)
      store.transitionTerminal('old-turn', { status: 'canceled', endedAt: 4, terminalReason: 'user_cancel' });
    if (clearLink) clearWindowsJobExecutionLink(link.path);
    if (unreadableLinks) {
      const linksDirectory = resolveWindowsJobLinksDirectory(dataDir);
      rmdirSync(linksDirectory);
      writeFileSync(linksDirectory, 'links directory is not readable');
    }
    releaseQuery();
    assert.deepEqual(await probing, blocked ? { invocationId: 'old-turn' } : undefined);
  });
});

[
  { finishesDuringRestore: false, restoreFails: false, drainFails: false },
  { finishesDuringRestore: true, restoreFails: false, drainFails: false },
  { finishesDuringRestore: false, restoreFails: true, drainFails: false },
  { finishesDuringRestore: false, restoreFails: false, drainFails: true },
].forEach(({ finishesDuringRestore, restoreFails, drainFails }) => {
  test(`#2008 stop-switch: finishes during restore=${finishesDuringRestore}, restore fails=${restoreFails}, drain fails=${drainFails}`, async (t) => {
    let finishTeardown;
    const teardown = new Promise((resolve) => {
      finishTeardown = resolve;
    });
    t.after(() => finishTeardown());
    const h = await stopFixture(t, { idle: true });
    const route = h.processor.deps.router.routeExecution;
    h.processor.deps.router.routeExecution = async function* (...args) {
      yield* route(...args);
      if (args[1] === 'active') await teardown;
    };
    await h.send('active');
    await h.processor.requestDrain('thread');
    await waitFor(() => h.starts.length === 1);
    const oldExecutionId = h.tracker.getExecutionId('thread', 'opus');
    const next = await h.send('new input');
    const restore = h.queue.restoreClaimedEntries.bind(h.queue);
    if (finishesDuringRestore)
      h.queue.restoreClaimedEntries = async (...args) => {
        finishTeardown();
        await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus', oldExecutionId));
        return restore(...args);
      };
    if (restoreFails) {
      let restoreAttempts = 0;
      h.queue.restoreClaimedEntries = (...args) =>
        restoreAttempts++ === 0 ? Promise.resolve(false) : restore(...args);
    }
    if (drainFails) {
      const drain = h.processor.requestDrain.bind(h.processor);
      let drainAttempts = 0;
      h.processor.requestDrain = (...args) =>
        drainAttempts++ === 0 ? Promise.reject(new Error('injected wake failure')) : drain(...args);
    }
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/threads/thread/queue/${next.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        sourceRecordId: next.message.id,
        observedPendingTargetIds: ['opus'],
        targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    if (restoreFails) {
      assert.equal(response.json().targets[0].status, 503);
      assert.equal(response.json().targets[0].result.code, 'STEER_START_FAILED');
    } else assert.equal(response.json().targets[0].result.outcome, 'queued');
    if (!finishesDuringRestore) {
      assert.deepEqual(h.starts, ['active'], 'a replacement must not enter while the old producer is closing');
      assert.equal(h.processor.hasProcessingSlotReservation('thread', 'opus', oldExecutionId), true);
      assert.equal((await h.queue.getDurableEntry('thread', next.entry.id)).status, 'queued');
    }
    finishTeardown();
    await waitFor(() => h.starts.includes('new input') && !h.processor.isThreadBusy('thread'));
    assert.equal(h.starts.filter((content) => content === 'new input').length, 1);
    assert.equal(h.messages.getById(next.message.id).content, 'new input');
    assert.equal(h.queue.list('thread', 'owner').length, 0);
    assert.equal(h.events.filter((event) => event.type === 'error').length, 0);
  });
});

test('#2008 an owner without its own Queue reservation keeps immediate admission', async (t) => {
  const h = await stopFixture(t, { idle: true });
  const previous = h.tracker.start('thread', 'opus', 'owner', ['opus'], 'external-owner');
  const next = await h.send('new input');
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/threads/thread/queue/${next.entry.id}/steer`,
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { mode: 'immediate' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().started, true);
  assert.equal(previous.signal.aborted, true);
  await waitFor(() => h.starts.length === 1 && !h.processor.isThreadBusy('thread'));
  assert.deepEqual(h.starts, ['new input']);
});

test('#2008 one streamed terminal error produces one visible error', async (t) => {
  const h = await stopFixture(t, { idle: true });
  const error = 'old provider still has a live owner';
  const route = h.processor.deps.router.routeExecution;
  let attempts = 0;
  h.processor.deps.router.routeExecution = async function* (...args) {
    if (attempts++ === 0) {
      yield { type: 'error', catId: 'opus', error, errorCode: 'prior_provider_live_owner', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      return;
    }
    yield* route(...args);
  };
  const processor = new QueueProcessor(h.processor.deps, { retryDeferral: { baseDelayMs: 20 } });
  const next = await h.send('new input');
  await processor.requestDrain('thread');
  await waitFor(() => h.starts.includes('new input') && !processor.isThreadBusy('thread'));
  assert.equal(h.events.filter((event) => event.type === 'error' && event.error === error).length, 1);
  assert.equal(h.starts.filter((content) => content === 'new input').length, 1);
  assert.equal(h.messages.getById(next.message.id).content, 'new input');
  assert.equal(h.queue.list('thread', 'owner').length, 0);
});
