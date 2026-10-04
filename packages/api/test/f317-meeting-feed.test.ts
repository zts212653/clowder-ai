import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startF317MeetingFeed } from '../src/domains/concierge/meeting/f317-meeting-feed.js';
import {
  createF317MeetingSource,
  type F317MeetingContext,
} from '../src/domains/concierge/meeting/f317-meeting-source.js';

test('F195 SSE is a wake hint; durable replay handles duplicate wakes and close rejects late wakes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f317-feed-'));
  try {
    const directory = join(root, 'thread-1');
    await mkdir(directory);
    const artifact = join(directory, 'transcript-mtg-1.lines.jsonl');
    await writeFile(artifact, '');
    await writeFile(
      join(directory, 'meta.json'),
      JSON.stringify({
        active: true,
        meeting_id: 'mtg-1',
        thread_id: 'thread-1',
        structured_transcript_path: artifact,
      }),
    );
    const audio = createF317MeetingSource({
      transcriptDir: root,
      audioServiceUrl: 'http://audio.test',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            running: true,
            meeting_id: 'mtg-1',
            thread_id: 'thread-1',
          }),
        ),
    });
    const received: F317MeetingContext[] = [];
    const subscription = audio.bind(
      { threadId: 'thread-1', meetingId: 'mtg-1', callId: 'call-1', generation: 5 },
      {
        onContext: (item) => received.push(item),
      },
    );
    let wake!: () => Promise<void> | void;
    let closed = false;
    const feed = await startF317MeetingFeed({
      threadId: 'thread-1',
      subscription,
      wakeSource: {
        subscribe: async (_threadId, callbacks) => {
          wake = callbacks.onTranscript;
          return {
            close: () => {
              closed = true;
            },
          };
        },
      },
      pollIntervalMs: 60_000,
    });
    await writeFile(
      artifact,
      `${JSON.stringify({
        v: 1,
        kind: 'transcript',
        cursor: 1,
        meeting_id: 'mtg-1',
        thread_id: 'thread-1',
        chunk_num: 1,
        revision: 1,
        line: { ts: 1_790_000_001, chunk_num: 1, text: 'hello', speaker_label: 'Speaker 1', speaker_confidence: 0.8 },
      })}\n`,
    );
    await wake();
    await wake();
    assert.equal(received.length, 1);
    feed.close();
    assert.equal(closed, true);
    await wake();
    assert.equal(received.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
