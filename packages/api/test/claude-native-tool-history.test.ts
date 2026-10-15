import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { transformClaudeEvent } from '../src/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import type { ClaudeStreamState } from '../src/domains/cats/services/agents/providers/claude-tool-events.js';
import { toStoredToolEvent } from '../src/domains/cats/services/agents/routing/stored-tool-events.js';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';

for (const capture of ['native', 'sdk']) {
  test(`real Claude ${capture} success/failure/Agent child results survive canonical disk history and cold read`, async () => {
    const raw = JSON.parse(
      await readFile(resolve(`packages/api/test/fixtures/claude-${capture}-tool-results.json`), 'utf8'),
    ) as unknown[];
    const state: ClaudeStreamState = {
      currentMessageId: undefined,
      partialTextMessageIds: new Set(),
      lastTurnInputTokens: undefined,
      thinkingBuffer: '',
    };
    const parsed: AgentMessage[] = [];
    for (const event of raw) {
      const result = transformClaudeEvent(event, createCatId('opus'), state);
      if (result) parsed.push(...(Array.isArray(result) ? result : [result]));
    }
    const uses = parsed.filter((e) => e.type === 'tool_use');
    const results = parsed.filter((e) => e.type === 'tool_result');
    assert.equal(uses.length, 5);
    assert.equal(results.length, 5);
    assert.equal(results.filter((e) => e.toolResultStatus === 'error').length, 2);
    assert.equal(results.filter((e) => e.toolParentUseId).length, 2);
    for (const use of uses) {
      const result = results.find((e) => e.toolUseId === use.toolUseId && e.toolParentUseId === use.toolParentUseId);
      assert.ok(result);
      assert.equal(result.toolName, use.toolName);
      assert.deepEqual(result.toolInput, use.toolInput);
    }
    const parent = resolve(`.cat-cafe/tmp/w1-${capture === 'native' ? 'real' : 'sdk'}-history`);
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, 'disk-'));
    const session = {
      sessionId: `w1-${capture}`,
      threadId: 'w1-thread',
      catId: 'opus',
      cliSessionId: `w1-${capture}-cli`,
      seq: 0,
    };
    const writer = new TranscriptWriter({ dataDir: dir });
    for (const event of parsed)
      writer.appendEvent(session, event as unknown as Record<string, unknown>, 'w1-real-invocation');
    await writer.drainPendingWrites();
    await writer.flush(session);
    const read = await new TranscriptReader({ dataDir: dir }).readEvents(
      session.sessionId,
      session.threadId,
      session.catId,
      undefined,
      100,
    );
    assert.equal(read.events.length, 10);
    assert.deepEqual(
      read.events.map((e) => e.event.toolRawPayload),
      parsed.map((e) => e.toolRawPayload),
    );
    const stored = parsed.map((event) => toStoredToolEvent(event, 'w1-real-invocation')).filter((e) => e !== null);
    assert.equal(stored.length, 10);
    assert.ok(stored.every((event) => event.executionRef === 'w1-real-invocation'));
    assert.equal(stored.filter((e) => e.status === 'error').length, 2);
    assert.equal(stored.filter((e) => e.toolParentUseId).length, 4);
    await writeFile(join(parent, 'replay.json'), JSON.stringify(read.events));
    await writeFile(join(parent, 'stored-tools.json'), JSON.stringify(stored));
    console.log(
      JSON.stringify({
        evidenceKind: 'real_native_data_through_production_parser_writer_reader',
        capture,
        directory: dir,
        toolUses: uses.length,
        toolResults: results.length,
        failures: 2,
        childResults: 2,
      }),
    );
  });
}
