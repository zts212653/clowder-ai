import assert from 'node:assert/strict';
import type { SessionRecord } from '@cat-cafe/shared';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import type { Thread } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createConversationStorageSourceReader } from '../src/domains/plugin/host-surface/conversation-storage-sources.js';

test('storage inventory includes registered native history, databases, and files from a live transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-storage-'));
  try {
    const transcriptDir = join(root, 'transcripts');
    const threadId = 'owner-thread';
    const event = {
      v: 1,
      t: 1,
      threadId,
      catId: 'codex',
      sessionId: 'session',
      eventNo: 1,
      event: { type: 'tool_use', toolName: 'Write', toolInput: { file_path: 'live-result.md' } },
    };
    const transcriptReader = new TranscriptReader({ dataDir: transcriptDir });
    const desktopAttachments = join(root, 'workspace', '.cat-cafe', 'dsh-desktop', 'profile', 'attachments');
    await mkdir(desktopAttachments, { recursive: true });
    const sessionDir = transcriptReader.getSessionDir(threadId, event.catId, event.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'events.live.jsonl'), JSON.stringify(event) + '\n');
    const read = createConversationStorageSourceReader({
      ownerUserId: 'owner',
      threads: {
        list: async () => [{ id: threadId, title: 'Owner', projectPath: root } as Thread],
        listDeleted: async (userId) => {
          assert.equal(userId, 'owner');
          return [{ id: 'retained-thread', title: 'Retained in Trash', projectPath: root } as Thread];
        },
      },
      messages: { getByThread: async () => [], getByThreadBefore: async () => [] },
      sessions: {
        getChainByThread: async () => [
          {
            id: event.sessionId,
            userId: 'owner',
            catId: event.catId,
            status: 'active',
            workingDirectory: root,
          } as SessionRecord,
        ],
      },
      transcriptReader,
      transcriptDir,
      uploadDir: join(root, 'uploads'),
      connectorMediaDir: join(root, 'connector-media'),
      dataDir: join(root, 'app-data'),
      workspaceRoot: join(root, 'workspace'),
      logDir: join(root, 'logs'),
      nativeHomes: { codex: join(root, 'codex'), kimi: join(root, 'kimi'), pi: join(root, 'pi') },
      nativeHistoryRoot: join(root, 'native-history'),
      databasePaths: [join(root, 'evidence.sqlite'), ':memory:'],
      cliArchiveDir: join(root, 'cli-archive'),
      tempDir: root,
    });
    const sources = await read(AbortSignal.timeout(5000));
    assert.deepEqual(
      sources.threads.map(({ id }) => id),
      [threadId, 'retained-thread'],
    );
    const roots = sources.roots.map((item) => item.path);
    for (const path of [
      join(root, 'codex', 'attachments'),
      join(root, 'kimi', 'sessions'),
      join(root, 'pi', 'sessions'),
      join(root, 'native-history', 'codex', 'archived_sessions'),
      join(root, 'cli-archive'),
      desktopAttachments,
    ]) {
      assert.ok(roots.includes(path), path);
    }
    assert.deepEqual(
      sources.files
        .filter((file) => file.category === 'database' && file.path.startsWith(join(root, 'evidence.sqlite')))
        .map((file) => file.path),
      ['evidence.sqlite', 'evidence.sqlite-wal', 'evidence.sqlite-shm'].map((name) => join(root, name)),
    );
    assert.ok(sources.files.some((file) => file.path === join(root, 'live-result.md') && file.threadId === threadId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
