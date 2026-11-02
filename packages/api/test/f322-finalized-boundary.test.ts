import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readMessageOutputLayout } from '@cat-cafe/shared';
import { AgyNativeProgress } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-progress.js';
import { parseAgyStreamJsonLine } from '../src/domains/cats/services/agents/providers/agy-stream-json-parser.js';
import { RoutingMessageOutputProjection } from '../src/domains/cats/services/agents/routing/message-output-projection.js';
import {
  createRoutingMessageTransform,
  toStoredToolEvent,
} from '../src/domains/cats/services/agents/routing/route-helpers.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';

const catId = 'gemini-argon' as AgentMessage['catId'];
const owner = { threadId: 'thread', catId, turnInvocationId: 'turn' };
const success = { succeeded: true, nativePhases: false };

function legacy(before: string, after: string) {
  const projection = new RoutingMessageOutputProjection(owner);
  projection.text({ type: 'text', catId, timestamp: 1, content: before });
  projection.tool({ id: 'read', type: 'tool_use', executionRef: 'turn', label: 'read', timestamp: 2 });
  projection.text({ type: 'text', catId, timestamp: 3, content: after });
  projection.settle(success);
  return projection;
}

test('real Gemini native history keeps its proven boundary after only the final newline is trimmed', () => {
  const rows: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/f322-gemini-argon-boundary.json', import.meta.url), 'utf8'),
  );
  const progress = new AgyNativeProgress(catId, {
    provider: 'google',
    model: 'gemini-4-argon-high',
    sessionId: '3afa4a86-b575-4666-becb-02a213e68409',
  });
  const transform = createRoutingMessageTransform();
  const projection = new RoutingMessageOutputProjection(owner);
  const accept = (message: AgentMessage) => {
    for (const frame of transform.transform(message)) {
      if (frame.type === 'text') projection.text(frame, transform.outputFactsFor(frame));
      const tool = toStoredToolEvent(frame, owner.turnInvocationId);
      if (tool) projection.tool(tool);
    }
  };
  let replacements = 0;
  for (const row of rows) {
    const event = parseAgyStreamJsonLine(JSON.stringify(row));
    if (event?.kind === 'step') for (const message of progress.step(event)) accept(message);
    if (event?.kind === 'result') {
      for (const message of progress.final([{ type: 'text', catId, timestamp: 4, content: event.response }])) {
        if (message.textMode === 'replace') replacements += 1;
        accept(message);
      }
    }
  }
  accept({ type: 'done', catId, timestamp: 5 });
  projection.settle(success);
  const raw = projection.snapshot();
  assert.equal(raw.content.length, 227);
  assert.equal(raw.layout.status, 'available');
  assert.ok(readMessageOutputLayout(raw.layout));
  assert.equal(replacements, 0);
  const final = projection.snapshot(raw.content.trimEnd());
  assert.equal(final.content.length, 226);
  assert.equal(final.layout.status, 'available');
  assert.equal(final.layout.basis, 'successful_turn_last_tool');
  assert.ok(readMessageOutputLayout(final.layout));
});

test('trimmed display ranges remain contiguous and retain all tool references', () => {
  for (const [before, answer] of [
    ['  Earlier  ', 'Answer.\n'],
    ['\n\n', 'Answer.\n'],
    ['  Earlier', '\nAnswer.\n'],
  ]) {
    const projection = legacy(before, answer);
    const raw = projection.snapshot();
    for (const content of [raw.content.trim(), raw.content.trimEnd()]) {
      const result = projection.snapshot(content);
      const layout = readMessageOutputLayout(result.layout);
      assert.equal(layout?.status, 'available');
      if (layout?.status !== 'available') throw new Error('Finalized boundary missing');
      assert.equal(layout.contentRevision.length, content.length);
      assert.equal(layout.runs.map((run) => content.slice(run.start, run.end)).join(''), content);
      assert.deepEqual(
        layout.order.filter((ref) => ref.kind === 'tool'),
        raw.layout.status === 'available' ? raw.layout.order.filter((ref) => ref.kind === 'tool') : [],
      );
      assert.ok(layout.runs.every((run) => run.end > run.start));
    }
  }
});

test('non-whitespace rewrites, incomplete turns and whole-body replacements remain unproven', () => {
  const projection = legacy('Earlier', 'Answer.\n');
  assert.equal(projection.snapshot('Earlier\n\nChanged answer.').layout.status, 'unavailable');
  projection.settle({ ...success, succeeded: false });
  assert.equal(projection.snapshot(projection.snapshot().content.trimEnd()).layout.status, 'unavailable');
  projection.text({ type: 'text', catId, timestamp: 6, textMode: 'replace', content: 'Replacement.\n' });
  projection.settle(success);
  assert.equal(projection.snapshot('Replacement.').layout.status, 'unavailable');
});

test('native phase layouts keep their existing strict content-revision behavior', () => {
  const projection = new RoutingMessageOutputProjection(owner);
  projection.text({
    type: 'text',
    catId,
    timestamp: 1,
    content: 'Answer.\n',
    outputMessage: {
      provider: 'codex',
      runtimeSessionId: 'native',
      turnId: 'native-turn',
      nativeId: 'answer',
      channel: 'final',
      complete: true,
      textMode: 'replace',
    },
  });
  projection.settle({ succeeded: true, nativePhases: true });
  assert.equal(projection.snapshot().layout.status, 'available');
  assert.equal(projection.snapshot('Answer.').layout.status, 'unavailable');
});
