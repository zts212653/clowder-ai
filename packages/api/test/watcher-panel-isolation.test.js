import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { watcherPanelSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { watcherPanelToolPolicy } from '../dist/domains/concierge/watcher/panel/watcher-panel-policy.js';

const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

test('a panel watcher run and the same cat’s ordinary turn never replace each other’s callback', async () => {
  const registry = new InvocationRegistry();
  const work1 = await registry.create('owner', 'codex', 'thread-1');
  const panel1 = await registry.create(
    'owner',
    'codex',
    'thread-1',
    'watcher-panel:r:codex',
    undefined,
    watcherPanelToolPolicy(),
  );
  assert.equal((await registry.verify(work1.invocationId, work1.callbackToken)).ok, true, 'panel leaves work alone');
  const work2 = await registry.create('owner', 'codex', 'thread-1');
  assert.equal((await registry.verify(panel1.invocationId, panel1.callbackToken)).ok, true, 'work leaves panel alone');
  assert.equal((await registry.verify(work2.invocationId, work2.callbackToken)).ok, true);
  const panel2 = await registry.create(
    'owner',
    'codex',
    'thread-1',
    'watcher-panel:r2:codex',
    undefined,
    watcherPanelToolPolicy(),
  );
  assert.equal((await registry.verify(panel1.invocationId, panel1.callbackToken)).ok, false, 'panel runs still rotate');
  assert.equal((await registry.verify(panel2.invocationId, panel2.callbackToken)).ok, true);
  assert.equal((await registry.verify(work2.invocationId, work2.callbackToken)).ok, true);
});

test('a cat’s session tools never list or open its panel-watcher session; the person still can', async () => {
  const { sessionChainRoutes } = await import('../dist/routes/session-chain.js');
  const { sessionTranscriptRoutes } = await import('../dist/routes/session-transcript.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'watcher-panel-isolation-'));
  dirs.push(dataDir);
  const sessionChainStore = new SessionChainStore();
  const threadStore = new ThreadStore();
  const transcriptReader = new TranscriptReader({ dataDir });
  const transcriptWriter = new TranscriptWriter({ dataDir });
  const app = Fastify({ logger: false });
  await app.register(sessionChainRoutes, { sessionChainStore, threadStore, transcriptReader });
  await app.register(sessionTranscriptRoutes, { sessionChainStore, threadStore, transcriptReader });
  await app.ready();
  try {
    const thread = await threadStore.create('owner');
    const home = await sessionChainStore.getOrCreateActive({ userId: 'owner', catId: 'codex', threadId: thread.id });
    const panel = await sessionChainStore.getOrCreateActive({
      userId: 'owner',
      catId: 'codex',
      threadId: thread.id,
      sessionPurpose: 'watcher',
      chainKey: watcherPanelSessionChainKey('owner', 'codex', thread.id),
    });
    await transcriptWriter.appendDurableEvent(
      { sessionId: panel.id, threadId: thread.id, catId: 'codex', seq: panel.seq },
      { type: 'tool_use', toolName: 'cat_cafe_watcher_nudge', toolInput: { sentence: 'UNIQUE_NUDGE_SENTENCE' } },
      'panel-invocation',
    );
    const cat = { 'x-cat-cafe-user': 'owner', 'x-cat-id': 'codex' };
    const person = { 'x-cat-cafe-user': 'owner' };

    const listed = (await app.inject({ url: `/api/threads/${thread.id}/sessions`, headers: cat })).json();
    const ids = listed.sessions.map((session) => session.id);
    assert.ok(ids.includes(home.id), 'its own working session stays listed');
    assert.equal(ids.includes(panel.id), false);
    for (const url of [
      `/api/sessions/${panel.id}`,
      `/api/sessions/${panel.id}/events?view=raw`,
      `/api/sessions/${panel.id}/digest`,
      `/api/sessions/${panel.id}/invocations/panel-invocation`,
    ]) {
      const response = await app.inject({ url, headers: cat });
      assert.ok([403, 404].includes(response.statusCode), `${url} -> ${response.statusCode}`);
      assert.equal(response.body.includes('UNIQUE_NUDGE_SENTENCE'), false, url);
    }
    const searched = await app.inject({
      url: `/api/threads/${thread.id}/sessions/search?q=UNIQUE_NUDGE_SENTENCE`,
      headers: cat,
    });
    assert.equal(searched.body.includes('UNIQUE_NUDGE_SENTENCE'), false, 'search stays inside readable sessions');
    const invocations = await app.inject({ url: `/api/threads/${thread.id}/invocations`, headers: cat });
    assert.equal(invocations.body.includes('panel-invocation'), false, 'the thread invocation list skips it');

    const owned = (await app.inject({ url: `/api/threads/${thread.id}/sessions`, headers: person })).json();
    assert.ok(
      owned.sessions.some((session) => session.id === panel.id),
      'the person’s view keeps it',
    );
    const raw = await app.inject({ url: `/api/sessions/${panel.id}/events?view=raw`, headers: person });
    assert.equal(raw.statusCode, 200);
    assert.match(raw.body, /UNIQUE_NUDGE_SENTENCE/);
  } finally {
    await app.close();
  }
});
