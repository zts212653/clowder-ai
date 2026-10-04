import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hookEntriesToAgentMessages } from '../src/domains/cats/services/agents/providers/HookSidechannelConsumer.js';
import { claudePostToolFileEvidence } from '../src/domains/cats/services/agents/providers/native-file-result-evidence.js';
import { extractRecentArtifacts } from '../src/domains/cats/services/agents/routing/artifact-tracking.js';
import { aggregateThreadArtifacts } from '../src/domains/cats/services/agents/routing/thread-artifacts-aggregator.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';

test('result evidence cannot be inferred from cwd, input, an MCP response or a failed native result', () => {
  const good = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_response: { filePath: '/real/file.txt' } };
  assert.equal(claudePostToolFileEvidence(good)?.absolutePath, '/real/file.txt');
  for (const entry of [
    { ...good, tool_name: 'mcp__files__Write' },
    { ...good, hook_event_name: 'PostToolUseFailure' },
    { ...good, tool_response: { filePath: '/real/file.txt', success: false } },
    { ...good, tool_response: { filePath: 'relative.txt' } },
    { ...good, tool_response: { filePath: '/bad\0path' } },
    { ...good, tool_response: undefined, cwd: '/current', tool_input: { file_path: 'file.txt' } },
  ])
    assert.equal(claudePostToolFileEvidence(entry), undefined);
});

test('new native file results preserve the actual path at birth across restart and two tool working directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'f309-file-birth-'));
  const writer = new TranscriptWriter({ dataDir: dir });
  const session = { sessionId: 's1', threadId: 't1', catId: 'opus5', seq: 0 };
  try {
    for (const [index, cwd] of ['/actual/A', '/actual/B'].entries()) {
      const [message] = hookEntriesToAgentMessages(
        [
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'Write',
            cwd,
            tool_use_id: `tool-${index}`,
            tool_input: { file_path: 'notes.txt' },
            tool_response: { filePath: `${cwd}/notes.txt`, type: 'create' },
          },
        ],
        { catId: 'opus5' },
      );
      assert.ok(message);
      writer.appendEvent(session, { ...message }, `invocation-${index}`);
    }
    const unknown = hookEntriesToAgentMessages(
      [
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Write',
          cwd: '/not-proof-of-result',
          tool_use_id: 'missing-result-path',
          tool_input: { file_path: 'legacy.txt' },
        },
      ],
      { catId: 'opus5' },
    )[0]!;
    writer.appendEvent(session, { ...unknown }, 'unknown');
    await writer.drainPendingWrites();
    const restarted = new TranscriptWriter({ dataDir: dir });
    const files = await restarted.getFilesTouched(session.sessionId, session);
    assert.deepEqual(files.map((file) => file.path).sort(), [
      '/actual/A/notes.txt',
      '/actual/B/notes.txt',
      'legacy.txt',
    ]);
    const ledger = extractRecentArtifacts({ filesTouched: files, prTasks: [], catId: 'opus5' });
    const artifacts = aggregateThreadArtifacts({ fileLedger: ledger, messages: [], prTasks: [] });
    assert.deepEqual(artifacts.map((artifact) => artifact.ref).sort(), [
      '/actual/A/notes.txt',
      '/actual/B/notes.txt',
      'legacy.txt',
    ]);
  } finally {
    await writer.drainPendingWrites();
    await rm(dir, { recursive: true, force: true });
  }
});
