import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createThreadStore(threadMemory = null) {
  return {
    get: async () => ({ id: 'thread-1', title: 'Artifacts Thread', userId: 'user-1', createdAt: Date.now() }),
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    getThreadMemory: async () => threadMemory,
    updateThreadMemory: async () => {},
  };
}

function createDeps(overrides = {}) {
  return {
    services: {},
    invocationDeps: {
      threadStore: overrides.threadStore ?? null,
      ...(overrides.sessionChainStore ? { sessionChainStore: overrides.sessionChainStore } : {}),
      ...(overrides.transcriptWriter ? { transcriptWriter: overrides.transcriptWriter } : {}),
    },
    messageStore: overrides.messageStore ?? new MessageStore(),
    deliveryCursorStore: overrides.deliveryCursorStore ?? new DeliveryCursorStore(),
  };
}

function appendToolUse(transcriptWriter, session, toolName, path) {
  transcriptWriter.appendEvent(
    {
      sessionId: session.id,
      threadId: session.threadId,
      catId: session.catId,
      cliSessionId: session.cliSessionId,
      seq: session.seq,
    },
    {
      type: 'tool_use',
      toolName,
      toolInput: { path },
    },
  );
}

describe('F232 live recent artifacts in incremental context', () => {
  it('falls back to the active session transcript buffer when recentFilesTouched is omitted', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-live-artifacts-'));
    tempDirs.push(dataDir);
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    appendToolUse(
      transcriptWriter,
      session,
      'Edit',
      'packages/api/src/domains/cats/services/agents/routing/route-helpers.ts',
    );
    appendToolUse(transcriptWriter, session, 'Read', 'README.md');

    const result = await assembleIncrementalContext(
      createDeps({
        transcriptWriter,
        sessionChainStore,
        threadStore: createThreadStore(),
      }),
      'user-1',
      'thread-1',
      'opus',
    );

    assert.ok(result.navigationHeader?.includes('route-helpers.ts'), 'live edited file should appear in navigation');
    assert.ok(result.contextText.includes('route-helpers.ts'), 'context text should include the live artifact');
    assert.ok(!result.navigationHeader?.includes('README.md'), 'read-only files must stay excluded');
  });

  it('prefers explicit recentFilesTouched over live transcript fallback', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-live-artifacts-override-'));
    tempDirs.push(dataDir);
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-2',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    appendToolUse(transcriptWriter, session, 'Edit', 'src/live-buffer.ts');

    const result = await assembleIncrementalContext(
      createDeps({
        transcriptWriter,
        sessionChainStore,
        threadStore: createThreadStore(),
      }),
      'user-1',
      'thread-1',
      'opus',
      undefined,
      undefined,
      {
        recentFilesTouched: [{ path: 'src/explicit-override.ts', ops: ['edit'] }],
      },
    );

    assert.ok(result.navigationHeader?.includes('explicit-override.ts'));
    assert.ok(!result.navigationHeader?.includes('live-buffer.ts'));
  });

  it('does not leak another user active session files on a shared thread', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-live-artifacts-scope-'));
    tempDirs.push(dataDir);
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-3',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'bob',
    });

    appendToolUse(transcriptWriter, session, 'Edit', 'src/bob-only.ts');

    const result = await assembleIncrementalContext(
      createDeps({
        transcriptWriter,
        sessionChainStore,
        threadStore: createThreadStore(),
      }),
      'alice',
      'thread-1',
      'opus',
    );

    assert.ok(!result.navigationHeader?.includes('bob-only.ts'));
    assert.ok(!result.contextText.includes('bob-only.ts'));
  });

  it('preserves unknown-tool file paths in the live transcript buffer', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-live-artifacts-unknown-op-'));
    tempDirs.push(dataDir);
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-4',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    appendToolUse(transcriptWriter, session, 'CustomEditTool', 'src/custom-op.ts');

    assert.deepEqual(await transcriptWriter.getFilesTouched(session.id), [{ path: 'src/custom-op.ts', ops: [] }]);
  });

  it('falls back to the caller-owned active session when another user owns the global active index', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-live-artifacts-active-fallback-'));
    tempDirs.push(dataDir);
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();

    const aliceSession = sessionChainStore.create({
      cliSessionId: 'cli-session-alice',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'alice',
    });
    appendToolUse(transcriptWriter, aliceSession, 'Edit', 'src/alice-live.ts');

    const bobSession = sessionChainStore.create({
      cliSessionId: 'cli-session-bob',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'bob',
    });
    appendToolUse(transcriptWriter, bobSession, 'Edit', 'src/bob-live.ts');

    const result = await assembleIncrementalContext(
      createDeps({
        transcriptWriter,
        sessionChainStore,
        threadStore: createThreadStore(),
      }),
      'alice',
      'thread-1',
      'opus',
    );

    assert.ok(result.navigationHeader?.includes('alice-live.ts'));
    assert.ok(!result.navigationHeader?.includes('bob-live.ts'));
  });

  it('recovers files-touched from disk after restart (incremental append, no seal)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-disk-fallback-'));
    tempDirs.push(dataDir);
    const writer1 = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-disk',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Append events — each appendEvent incrementally writes to disk
    appendToolUse(writer1, session, 'Edit', 'src/edited-file.ts');
    appendToolUse(writer1, session, 'Read', 'src/read-only.ts');
    await writer1.drainPendingWrites(session.id);

    // Simulate restart: new writer with empty buffer, same dataDir
    const writer2 = new TranscriptWriter({ dataDir });
    assert.equal(writer2.getEventCount(session.id), 0, 'new writer has empty buffer');

    // Disk fallback should recover from incremental JSONL
    const filesTouched = await writer2.getFilesTouched(session.id, {
      threadId: session.threadId,
      catId: session.catId,
    });

    const editedFile = filesTouched.find((f) => f.path === 'src/edited-file.ts');
    assert.ok(editedFile, 'edited file should be recovered from disk JSONL');
    assert.ok(editedFile.ops.includes('edit'), 'edit op should be present');

    const readFile = filesTouched.find((f) => f.path === 'src/read-only.ts');
    assert.ok(readFile, 'read file should also be recovered from disk JSONL');
    assert.ok(readFile.ops.includes('read'), 'read op should be present');
  });

  it('merges pre-restart and post-restart file touches across restart boundary', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f232-restart-merge-'));
    tempDirs.push(dataDir);
    const writer1 = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-merge',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Pre-restart: edit a file
    appendToolUse(writer1, session, 'Edit', 'src/before-restart.ts');
    await writer1.drainPendingWrites(session.id);

    // Simulate restart: new writer, same dataDir
    const writer2 = new TranscriptWriter({ dataDir });

    // Post-restart: edit another file (buffer + disk both get this event)
    appendToolUse(writer2, session, 'Edit', 'src/after-restart.ts');
    await writer2.drainPendingWrites(session.id);

    // Should see BOTH pre-restart and post-restart files
    const filesTouched = await writer2.getFilesTouched(session.id, {
      threadId: session.threadId,
      catId: session.catId,
    });

    assert.ok(
      filesTouched.find((f) => f.path === 'src/before-restart.ts'),
      'pre-restart file should be recovered from disk',
    );
    assert.ok(
      filesTouched.find((f) => f.path === 'src/after-restart.ts'),
      'post-restart file should be present from buffer',
    );
  });

  it('flush after restart includes pre-restart events in canonical transcript', async () => {
    const { readFile: fsReadFile } = await import('node:fs/promises');

    const dataDir = mkdtempSync(join(tmpdir(), 'f232-flush-merge-'));
    tempDirs.push(dataDir);
    const writer1 = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-flush-merge',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Pre-restart: edit a file
    appendToolUse(writer1, session, 'Edit', 'src/before-restart.ts');
    await writer1.drainPendingWrites(session.id);

    // Simulate restart
    const writer2 = new TranscriptWriter({ dataDir });
    appendToolUse(writer2, session, 'Edit', 'src/after-restart.ts');

    // Seal (flush) from the post-restart writer
    await writer2.flush(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { createdAt: Date.now() - 1000, sealedAt: Date.now() },
    );

    // Read canonical events.jsonl — should contain both segments
    const eventsPath = join(
      dataDir,
      'threads',
      session.threadId,
      session.catId,
      'sessions',
      session.id,
      'events.jsonl',
    );
    const content = await fsReadFile(eventsPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    assert.ok(lines.length >= 2, `canonical transcript should have >=2 events, got ${lines.length}`);

    const paths = lines.map((l) => JSON.parse(l).event?.toolInput?.path).filter(Boolean);
    assert.ok(paths.includes('src/before-restart.ts'), 'pre-restart file in canonical transcript');
    assert.ok(paths.includes('src/after-restart.ts'), 'post-restart file in canonical transcript');
  });

  it('flush preserves buffer events when live file is shorter due to failed disk writes', async () => {
    const { readFile: fsReadFile, writeFile: fsWriteFile } = await import('node:fs/promises');

    const dataDir = mkdtempSync(join(tmpdir(), 'f232-flush-diskfail-'));
    tempDirs.push(dataDir);
    const writer1 = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-flush-diskfail',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Pre-restart: 2 events written to disk
    appendToolUse(writer1, session, 'Edit', 'src/pre1.ts');
    appendToolUse(writer1, session, 'Edit', 'src/pre2.ts');
    await writer1.drainPendingWrites(session.id);

    // Simulate restart
    const writer2 = new TranscriptWriter({ dataDir });

    // Post-restart: 2 events (both go to buffer + disk)
    appendToolUse(writer2, session, 'Edit', 'src/post1.ts');
    appendToolUse(writer2, session, 'Edit', 'src/post2.ts');
    await writer2.drainPendingWrites(session.id);

    // Simulate disk write failure: truncate last line from events.live.jsonl
    // This mimics post2's disk append failing (best-effort catch swallowed the error)
    // while the event remains in the in-memory buffer.
    const sessionDir = join(dataDir, 'threads', session.threadId, session.catId, 'sessions', session.id);
    const liveFilePath = join(sessionDir, 'events.live.jsonl');
    const content = await fsReadFile(liveFilePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 4, 'live file should have 4 events before truncation');
    // Remove last line (post2) — simulates its disk write having failed
    await fsWriteFile(liveFilePath, `${lines.slice(0, 3).join('\n')}\n`, 'utf-8');

    // State: liveEvents=3 [pre1, pre2, post1], buf=2 [post1, post2]
    // Bug: liveEvents(3) > buf(2) → buf = liveEvents → loses post2
    // Fix: merge → preserves post2 from buffer

    await writer2.flush(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { createdAt: Date.now() - 1000, sealedAt: Date.now() },
    );

    const eventsPath = join(sessionDir, 'events.jsonl');
    const canonical = await fsReadFile(eventsPath, 'utf-8');
    const eventLines = canonical.split('\n').filter((l) => l.trim());
    const paths = eventLines.map((l) => JSON.parse(l).event?.toolInput?.path).filter(Boolean);

    // All 4 events must be present in canonical transcript
    assert.ok(paths.includes('src/pre1.ts'), 'pre-restart event 1 preserved');
    assert.ok(paths.includes('src/pre2.ts'), 'pre-restart event 2 preserved');
    assert.ok(paths.includes('src/post1.ts'), 'post-restart event 1 preserved');
    assert.ok(
      paths.includes('src/post2.ts'),
      'post-restart event 2 (buffer-only after simulated disk failure) preserved',
    );
    assert.equal(eventLines.length, 4, 'exactly 4 events in canonical transcript');
  });

  it('flush merges pre-restart events even when buffer is longer than live file', async () => {
    const { readFile: fsReadFile, writeFile: fsWriteFile } = await import('node:fs/promises');

    const dataDir = mkdtempSync(join(tmpdir(), 'f232-flush-buf-longer-'));
    tempDirs.push(dataDir);
    const writer1 = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-flush-buf-longer',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Pre-restart: 1 event
    appendToolUse(writer1, session, 'Edit', 'src/pre-restart.ts');
    await writer1.drainPendingWrites(session.id);

    // Simulate restart
    const writer2 = new TranscriptWriter({ dataDir });

    // Post-restart: 3 events (all go to buffer + disk)
    appendToolUse(writer2, session, 'Edit', 'src/post1.ts');
    appendToolUse(writer2, session, 'Edit', 'src/post2.ts');
    appendToolUse(writer2, session, 'Edit', 'src/post3.ts');
    await writer2.drainPendingWrites(session.id);

    // Simulate 2 disk write failures: truncate last 2 lines from events.live.jsonl
    // Live file: [pre-restart, post1, post2, post3] → truncate to [pre-restart, post1]
    // Buffer: [post1, post2, post3] (3 events)
    // Now liveEvents(2) < buf(3) — row-count guard would skip merge entirely,
    // losing pre-restart event even though it's on disk.
    const sessionDir = join(dataDir, 'threads', session.threadId, session.catId, 'sessions', session.id);
    const liveFilePath = join(sessionDir, 'events.live.jsonl');
    const content = await fsReadFile(liveFilePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 4, 'live file should have 4 events before truncation');
    await fsWriteFile(liveFilePath, `${lines.slice(0, 2).join('\n')}\n`, 'utf-8');

    await writer2.flush(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { createdAt: Date.now() - 1000, sealedAt: Date.now() },
    );

    const eventsPath = join(sessionDir, 'events.jsonl');
    const canonical = await fsReadFile(eventsPath, 'utf-8');
    const eventLines = canonical.split('\n').filter((l) => l.trim());
    const paths = eventLines.map((l) => JSON.parse(l).event?.toolInput?.path).filter(Boolean);

    // All 4 events must be present — pre-restart from disk, all post-restart from buffer
    assert.ok(paths.includes('src/pre-restart.ts'), 'pre-restart event preserved from disk');
    assert.ok(paths.includes('src/post1.ts'), 'post-restart event 1 preserved');
    assert.ok(paths.includes('src/post2.ts'), 'post-restart event 2 preserved (buffer-only)');
    assert.ok(paths.includes('src/post3.ts'), 'post-restart event 3 preserved (buffer-only)');
    assert.equal(eventLines.length, 4, 'exactly 4 events in canonical transcript');
  });

  it('flush after restart with zero post-restart events still produces canonical transcript', async () => {
    const { readFile: fsReadFile, access } = await import('node:fs/promises');

    const dataDir = mkdtempSync(join(tmpdir(), 'f232-flush-zero-post-'));
    tempDirs.push(dataDir);
    const writer1 = new TranscriptWriter({ dataDir });
    const sessionChainStore = new SessionChainStore();
    const session = sessionChainStore.create({
      cliSessionId: 'cli-session-flush-zero',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Pre-restart: write events
    appendToolUse(writer1, session, 'Edit', 'src/pre-restart-only.ts');
    appendToolUse(writer1, session, 'Read', 'src/read-before.ts');
    await writer1.drainPendingWrites(session.id);

    // Simulate restart: new writer, NO new appendEvent calls
    const writer2 = new TranscriptWriter({ dataDir });
    assert.equal(writer2.getEventCount(session.id), 0, 'post-restart writer has empty buffer');

    // Seal (flush) from post-restart writer — buffer is empty but live file exists
    await writer2.flush(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { createdAt: Date.now() - 1000, sealedAt: Date.now() },
    );

    const sessionDir = join(dataDir, 'threads', session.threadId, session.catId, 'sessions', session.id);

    // Canonical events.jsonl must exist with pre-restart events
    const content = await fsReadFile(join(sessionDir, 'events.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.ok(lines.length >= 2, `canonical transcript should have >=2 events, got ${lines.length}`);

    const paths = lines.map((l) => JSON.parse(l).event?.toolInput?.path).filter(Boolean);
    assert.ok(paths.includes('src/pre-restart-only.ts'), 'pre-restart edit in canonical transcript');
    assert.ok(paths.includes('src/read-before.ts'), 'pre-restart read in canonical transcript');

    // digest.extractive.json must exist (sealTimestamps were provided)
    await access(join(sessionDir, 'digest.extractive.json'));

    // events.live.jsonl should be cleaned up
    await assert.rejects(
      () => access(join(sessionDir, 'events.live.jsonl')),
      'events.live.jsonl should be deleted after flush',
    );
  });
});
