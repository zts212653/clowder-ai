import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');

describe('GET /api/threads/:threadId/artifacts (F232)', () => {
  let app;
  const tempDirs = [];
  afterEach(async () => {
    if (app) await app.close();
    app = null;
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  async function makeApp({
    thread = { id: 'T1', createdBy: 'alice' },
    messages = [],
    tasks = [],
    memory = null,
    sessionChainStore,
    transcriptWriter,
  } = {}) {
    const threadStore = {
      get: async (id) => (thread && id === thread.id ? thread : null),
      getThreadMemory: async () => memory,
    };
    const a = Fastify();
    await a.register(threadsRoutes, {
      threadStore,
      messageStore: { getByThread: async () => messages, getByThreadBefore: async () => [] },
      taskStore: { listByThread: async () => tasks },
      ...(sessionChainStore ? { sessionChainStore } : {}),
      ...(transcriptWriter ? { transcriptWriter } : {}),
    });
    return a;
  }

  const AUTH = { 'x-cat-cafe-user': 'alice' };

  it('401 when no identity', async () => {
    app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts' });
    assert.equal(res.statusCode, 401);
  });

  it('404 when thread not found', async () => {
    app = await makeApp({ thread: null });
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 404);
  });

  it('403 when not owner', async () => {
    app = await makeApp({ thread: { id: 'T1', createdBy: 'bob' } });
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 403);
  });

  it('200 aggregates rich blocks + PR + file ledger, time-desc, filters non-pr tasks & non-file ledger', async () => {
    app = await makeApp({
      thread: { id: 'T1', createdBy: 'alice' },
      messages: [
        {
          id: 'm1',
          catId: 'opus-48',
          timestamp: 100,
          extra: { rich: { blocks: [{ kind: 'file', v: 1, id: 'b1', url: '/uploads/r.pdf', fileName: 'r.pdf' }] } },
        },
      ],
      tasks: [
        {
          kind: 'pr_tracking',
          subjectKey: 'pr:o/r#9',
          title: 'fix',
          ownerCatId: 'opus-47',
          status: 'open',
          updatedAt: 200,
          userId: 'alice',
        },
        { kind: 'work', subjectKey: 'w', title: 'work', ownerCatId: 'c', status: 'open', updatedAt: 999 }, // filtered (not pr_tracking)
      ],
      memory: {
        recentArtifacts: [
          { type: 'file', ref: 'src/x.ts', label: 'x.ts', updatedAt: 50, updatedBy: 'c' },
          { type: 'pr', ref: 'ignored', label: 'ledger-pr', updatedAt: 60, updatedBy: 'c' }, // filtered (handler takes type==='file')
        ],
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.threadId, 'T1');
    assert.equal(body.artifacts.length, 3); // file(msg) + PR + file(ledger); work task & ledger-pr filtered out
    assert.equal(body.artifacts[0].type, 'pr'); // updatedAt 200, newest
    assert.equal(body.artifacts[0].ref, 'o/r#9');
    assert.equal(body.artifacts[1].type, 'file'); // msg, 100
    assert.equal(body.artifacts[1].sourceMessageId, 'm1');
    assert.equal(body.artifacts[2].ref, 'src/x.ts'); // ledger, 50, oldest
  });

  it('P1 (cloud round 4): shared system-thread artifacts are user-scoped — Alice cannot see Bob PR tasks', async () => {
    // access guard (line 718) lets ANY authed user read createdBy==='system' threads (shared default thread).
    // PR tracking tasks carry userId: principal.userId — without user-scoping, Alice sees Bob's PR titles/refs.
    app = await makeApp({
      thread: { id: 'shared', createdBy: 'system' },
      tasks: [
        {
          kind: 'pr_tracking',
          subjectKey: 'pr:o/r#1',
          title: 'alice-pr',
          ownerCatId: 'c',
          status: 'open',
          updatedAt: 100,
          userId: 'alice',
        },
        {
          kind: 'pr_tracking',
          subjectKey: 'pr:o/r#2',
          title: 'bob-pr',
          ownerCatId: 'c',
          status: 'open',
          updatedAt: 200,
          userId: 'bob',
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/threads/shared/artifacts', headers: AUTH }); // AUTH = alice
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const prRefs = body.artifacts.filter((a) => a.type === 'pr').map((a) => a.ref);
    assert.deepEqual(
      prRefs,
      ['o/r#1'],
      'Alice sees only her own PR task — Bob PR must not leak on shared system thread',
    );
  });

  it('P1 (砚砚): aggregates artifacts beyond the default 50-message window (no truncation)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const messageStore = new MessageStore();
    const base = Date.now();
    // earliest message carries the file artifact, then push 59 newer plain messages past the default-50 window
    messageStore.append({
      userId: 'alice',
      catId: 'opus-48',
      content: '',
      mentions: [],
      timestamp: base,
      threadId: 'T1',
      extra: {
        rich: { v: 1, blocks: [{ id: 'b', kind: 'file', v: 1, url: '/uploads/early.pdf', fileName: 'early.pdf' }] },
      },
    });
    for (let i = 1; i <= 59; i++) {
      messageStore.append({
        userId: 'alice',
        catId: 'opus-48',
        content: `m${i}`,
        mentions: [],
        timestamp: base + i,
        threadId: 'T1',
      });
    }
    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore: { get: async () => ({ id: 'T1', createdBy: 'alice' }), getThreadMemory: async () => null },
      messageStore,
      taskStore: { listByThread: async () => [] },
    });
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // early.pdf is the oldest of 60 — default getByThread(limit=50) would drop it; full scan must keep it
    assert.ok(
      body.artifacts.some((a) => a.name === 'early.pdf'),
      'earliest file artifact beyond limit-50 must survive',
    );
  });

  it('P1 (砚砚): ledger plan / feature-doc artifacts are collected, not only file', async () => {
    app = await makeApp({
      thread: { id: 'T1', createdBy: 'alice' },
      memory: {
        recentArtifacts: [
          { type: 'plan', ref: 'docs/plans/x.md', label: 'x.md', updatedAt: 50, updatedBy: 'c' },
          { type: 'feature-doc', ref: 'docs/features/F1.md', label: 'F1.md', updatedAt: 60, updatedBy: 'c' },
          { type: 'file', ref: 'src/y.ts', label: 'y.ts', updatedAt: 70, updatedBy: 'c' },
        ],
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.artifacts.length, 3); // plan + feature-doc + source file all collected
    assert.deepEqual(Object.fromEntries(body.artifacts.map((a) => [a.ref, a.type])), {
      'docs/plans/x.md': 'file',
      'docs/features/F1.md': 'file',
      'src/y.ts': 'code',
    });
  });

  it('P1 (cloud): active-session file artifacts appear before session seal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-thread-artifacts-live-'));
    tempDirs.push(dataDir);
    const sessionChainStore = new SessionChainStore();
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const activeSession = sessionChainStore.create({
      cliSessionId: 'cli-live-1',
      threadId: 'T1',
      catId: 'opus',
      userId: 'alice',
    });

    const sessionInfo = {
      sessionId: activeSession.id,
      threadId: activeSession.threadId,
      catId: activeSession.catId,
      cliSessionId: activeSession.cliSessionId,
      seq: activeSession.seq,
    };
    transcriptWriter.appendEvent(sessionInfo, {
      type: 'tool_use',
      toolName: 'Edit',
      toolInput: { path: 'packages/api/src/routes/threads.ts' },
    });
    transcriptWriter.appendEvent(sessionInfo, {
      type: 'tool_use',
      toolName: 'Read',
      toolInput: { path: 'README.md' },
    });

    app = await makeApp({
      thread: { id: 'T1', createdBy: 'alice' },
      sessionChainStore,
      transcriptWriter,
    });
    const res = await app.inject({ method: 'GET', url: '/api/threads/T1/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const refs = body.artifacts.map((a) => a.ref);
    assert.ok(refs.includes('packages/api/src/routes/threads.ts'), 'live edited file should appear before seal');
    assert.ok(!refs.includes('README.md'), 'read-only live file must stay excluded');
  });

  it('P1 (cloud): shared thread live file ledger is user-scoped', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-thread-artifacts-live-scope-'));
    tempDirs.push(dataDir);
    const sessionChainStore = new SessionChainStore();
    const transcriptWriter = new TranscriptWriter({ dataDir });

    const bobSession = sessionChainStore.create({
      cliSessionId: 'cli-bob-1',
      threadId: 'shared',
      catId: 'opus',
      userId: 'bob',
    });
    transcriptWriter.appendEvent(
      {
        sessionId: bobSession.id,
        threadId: bobSession.threadId,
        catId: bobSession.catId,
        cliSessionId: bobSession.cliSessionId,
        seq: bobSession.seq,
      },
      {
        type: 'tool_use',
        toolName: 'Edit',
        toolInput: { path: 'src/bob-secret.ts' },
      },
    );

    app = await makeApp({
      thread: { id: 'shared', createdBy: 'system' },
      sessionChainStore,
      transcriptWriter,
    });
    const res = await app.inject({ method: 'GET', url: '/api/threads/shared/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const refs = body.artifacts.map((a) => a.ref);
    assert.ok(!refs.includes('src/bob-secret.ts'), 'Alice must not see Bob live files on shared thread');
  });
});
