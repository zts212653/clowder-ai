import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { toStoredToolEvent } from '../../dist/domains/cats/services/agents/routing/route-helpers.js';
import { TranscriptWriter } from '../../dist/domains/cats/services/session/TranscriptWriter.js';

it('passes DSH tool facts through the actual service, UI history projection, and transcript storage', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'acp-tool-pipeline-'));
  const rawInput = { command: 'fixture-read-only', path: '/fixture/a.txt' };
  const rawContent = [
    { type: 'content', content: { type: 'text', text: 'fixture error '.repeat(160) } },
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'raw-fixture-bytes' } },
  ];
  let released = 0;
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    async newSession() {
      return { sessionId: 'fixture-session', configOptions: [] };
    },
    async *promptStream(sessionId) {
      yield {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'fixture-call',
          title: 'read_file',
          status: 'in_progress',
          rawInput,
        },
      };
      yield {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'fixture-call',
          status: 'failed',
          content: rawContent,
        },
      };
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture done.' } },
      };
    },
  };
  const service = new AcpAgentService({
    catId: 'dsh',
    providerName: 'dsh',
    modelName: 'fixture-profile',
    projectRoot: dataDir,
    poolKey: { projectPath: dataDir, providerProfile: 'fixture' },
    pool: {
      async acquire() {
        return {
          client,
          release() {
            released++;
          },
        };
      },
    },
    mcpSupport: false,
  });
  const outputs = [];
  for await (const msg of service.invoke('Deterministic transport fixture')) outputs.push(msg);
  assert.equal(
    outputs.some((msg) => msg.type === 'error'),
    false,
  );
  assert.equal(released, 1);
  const use = outputs.find((msg) => msg.type === 'tool_use');
  const result = outputs.find((msg) => msg.type === 'tool_result');
  assert.equal(use.toolUseId, 'fixture-call');
  assert.equal(result.toolUseId, use.toolUseId);
  assert.equal(result.toolName, 'read_file');
  assert.equal(result.toolResultStatus, 'error');
  const summary = toStoredToolEvent(result);
  assert.equal(summary.toolUseId, 'fixture-call');
  assert.equal(summary.status, 'error');
  assert.ok(summary.detail.length < result.content.length);
  assert.doesNotMatch(result.content, /raw-fixture-bytes/);

  const writer = new TranscriptWriter({ dataDir });
  const session = { sessionId: 'logical-fixture', threadId: 'fixture-thread', catId: 'dsh', seq: 0 };
  writer.appendEvent(session, use, 'fixture-invocation');
  writer.appendEvent(session, result, 'fixture-invocation');
  await writer.flush(session);
  await writer.drainPendingWrites();
  const path = join(dataDir, 'threads', session.threadId, session.catId, 'sessions', session.sessionId, 'events.jsonl');
  const stored = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const persistedResult = stored.find((entry) => entry.event.type === 'tool_result');
  assert.deepEqual(persistedResult.event.toolRawPayload.rawInput, rawInput);
  assert.deepEqual(persistedResult.event.toolRawPayload.content, rawContent);
  assert.equal(persistedResult.event.toolResultStatus, 'error');
  // Retain this fresh fixture directory; never remove existing transcript storage.
});
