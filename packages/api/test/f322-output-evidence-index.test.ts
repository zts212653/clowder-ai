import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { compactTranscriptEvent } from '../src/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import type { SessionIndexInput } from '../src/domains/cats/services/session/transcript-index/transcript-invocation-index-types.js';
import { readTranscriptInvocationIndex } from '../src/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';

const session = { id: 'session', threadId: 'thread', catId: 'codex-sol', seq: 0, status: 'active' } as const;
const native = {
  provider: 'codex',
  runtimeSessionId: 'native',
  turnId: 'turn',
  nativeId: 'first',
  channel: 'commentary',
  complete: true,
  textMode: 'replace',
};
const event = (invocationId: string, eventNo: number, payload: Record<string, unknown>) => ({
  v: 1 as const,
  t: 1000 + eventNo,
  ...session,
  sessionId: session.id,
  invocationId,
  eventNo,
  event: payload,
});
const jsonl = (events: unknown[]) => `${events.map((value) => JSON.stringify(value)).join('\n')}\n`;

test('a prior clipped projection version is rescanned, then warm reads use only the bounded derived cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f322-evidence-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input: SessionIndexInput = { session, directory, buffered: [], includeLive: true };
  const read = () => readTranscriptInvocationIndex({ sessions: [input], query: { kind: 'list', limit: 200 } });
  const content = 'first native output beyond 140 chars. '.repeat(15);
  const original = jsonl([event('inv', 0, { type: 'text', content, outputMessage: native })]);
  await writeFile(join(directory, 'events.live.jsonl'), original);
  const cold = await read();
  assert.equal(cold.invocations[0].firstAssistantOutputEvidence?.content, content);
  const db = new Database(join(directory, 'invocations.v1.sqlite'));
  db.prepare("UPDATE sources SET signature = 'previous-projection-version'").run();
  for (const row of db.prepare('SELECT source, seq, projection FROM source_events').all() as {
    source: number;
    seq: number;
    projection: string;
  }[]) {
    const oldProjection = JSON.parse(row.projection);
    delete oldProjection.event.assistantOutputFragment;
    db.prepare('UPDATE source_events SET projection = ? WHERE source = ? AND seq = ?').run(
      JSON.stringify(oldProjection),
      row.source,
      row.seq,
    );
  }
  db.close();
  const rebuilt = await read();
  assert.equal(rebuilt.invocations[0].firstAssistantOutputEvidence?.content, content);
  assert.equal(rebuilt.diagnostics.sourceBytesScanned, Buffer.byteLength(original));
  assert.equal((await read()).diagnostics.sourceBytesScanned, 0);
  assert.equal(await readFile(join(directory, 'events.live.jsonl'), 'utf8'), original);
  await appendFile(join(directory, 'events.live.jsonl'), jsonl([event('inv', 1, { type: 'done' })]));
  const appended = await read();
  assert.ok(appended.diagnostics.sourceBytesScanned < Buffer.byteLength(original));
  assert.equal(appended.invocations[0].firstAssistantOutputEvidence?.content, content);
});

test('source/drill uses canonical cursor numbering across live and buffered overlay, never native eventNo', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f322-evidence-drill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = event('inv', 0, { type: 'text', content: 'You，', outputMessage: native });
  await writeFile(join(directory, 'events.jsonl'), jsonl([event('previous', 0, { type: 'done' })]));
  await writeFile(join(directory, 'events.live.jsonl'), jsonl([output]));
  const input: SessionIndexInput = {
    session,
    directory,
    buffered: [compactTranscriptEvent(output)],
    includeLive: true,
  };
  const list = await readTranscriptInvocationIndex({ sessions: [input], query: { kind: 'list', limit: 200 } });
  const source = list.invocations.find((item) => item.invocationId === 'inv')?.firstAssistantOutputEvidence?.source;
  assert.ok(source);
  assert.equal(source.firstEventNo, 1);
  assert.equal(source.lastEventNo, 1);
  const buffered = await readTranscriptInvocationIndex({
    sessions: [input],
    query: { kind: 'invocation', invocationId: source.invocationId, cursor: source.firstEventNo, limit: 1 },
  });
  assert.deepEqual(buffered.pages[0].events, [{ bufferIndex: 0, eventNo: 1 }]);
  input.buffered = [];
  const live = await readTranscriptInvocationIndex({
    sessions: [input],
    query: { kind: 'invocation', invocationId: 'inv', cursor: 1, limit: 1 },
  });
  assert.equal(live.pages[0].events[0].event?.eventNo, 1);
  assert.deepEqual(live.pages[0].events[0].event?.event, output.event);
  assert.equal(live.pages[0].summary?.firstAssistantOutputEvidence?.content, 'You，');
});
