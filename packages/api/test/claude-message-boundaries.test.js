import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { transcriptEntriesToAgentMessages } from '../dist/domains/cats/services/agents/providers/BgTranscriptEventConsumer.js';
import { ClaudeBgCarrierService } from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { transformClaudeEvent } from '../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import { parseA2AMentions } from '../dist/domains/cats/services/agents/routing/a2a-mentions.js';
import { accumulateTextAggregate } from '../dist/domains/cats/services/agents/text-aggregation.js';

function state() {
  return { currentMessageId: undefined, partialTextMessageIds: new Set(), thinkingBuffer: '' };
}

function collect(events, streamState = state()) {
  let text = '';
  for (const event of events) {
    const output = transformClaudeEvent(event, 'opus', streamState);
    for (const message of Array.isArray(output) ? output : output ? [output] : []) {
      if (message.type === 'text') text = accumulateTextAggregate(text, message.content, message.textMode);
    }
  }
  return text;
}

const start = (id) => ({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
const delta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});
const stop = () => ({ type: 'stream_event', event: { type: 'message_stop' } });
const snapshot = (id, content) => ({ type: 'assistant', message: { id, content } });
const textBlock = (text) => ({ type: 'text', text });

test('streamed assistant-message boundary preserves a final line-start handoff', () => {
  const text = collect([start('progress'), delta('等 alpha 就绪：'), stop(), start('final'), delta('@codex\n请处理')]);
  assert.equal(text, '等 alpha 就绪：\n\n@codex\n请处理');
  assert.deepEqual(parseA2AMentions(text, 'opus'), ['codex']);
});

test('token fragments inside one assistant message concatenate without added whitespace', () => {
  const text = collect([start('one'), delta('报告：\n@co'), delta('dex\n请处理')]);
  assert.equal(text, '报告：\n@codex\n请处理');
  assert.deepEqual(parseA2AMentions(text, 'opus'), ['codex']);
});

test('non-streaming snapshots preserve separate messages but not arbitrary block boundaries', () => {
  const text = collect([
    snapshot('progress', [textBlock('进度：')]),
    snapshot('final', [textBlock('@co'), textBlock('dex\n请处理')]),
  ]);
  assert.equal(text, '进度：\n\n@codex\n请处理');
  assert.deepEqual(parseA2AMentions(text, 'opus'), ['codex']);
});

test('a streaming message followed by a non-streaming final message shares the boundary rule', () => {
  const text = collect([start('progress'), delta('进度：'), stop(), snapshot('final', [textBlock('@codex\n请处理')])]);
  assert.equal(text, '进度：\n\n@codex\n请处理');
});

test('final snapshots of already streamed messages neither duplicate text nor add extra paragraphs', () => {
  const text = collect([
    start('progress'),
    delta('进度：'),
    stop(),
    snapshot('progress', [textBlock('进度：')]),
    start('final'),
    delta('@codex\n请处理'),
    stop(),
    snapshot('final', [textBlock('@codex\n请处理')]),
  ]);
  assert.equal(text, '进度：\n\n@codex\n请处理');
});

test('tool-only and thinking-only messages do not produce blank text or a leading paragraph', () => {
  const text = collect([
    snapshot('tool', [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }]),
    snapshot('thinking', [{ type: 'thinking', thinking: '分析' }]),
    snapshot('final', [textBlock('@codex\n请处理')]),
  ]);
  assert.equal(text, '@codex\n请处理');
});

test('an inline mention stays inline; fenced mentions remain non-routable', () => {
  const text = collect([
    snapshot('progress', [textBlock('进度')]),
    snapshot('final', [textBlock('请 @codex 处理\n```\n@codex\n```')]),
  ]);
  assert.deepEqual(parseA2AMentions(text, 'opus'), []);
});

test('known same-message snapshots and legacy id-less text retain their exact text', () => {
  assert.equal(collect([snapshot('one', [textBlock('hel')]), snapshot('one', [textBlock('lo')])]), 'hello');
  assert.equal(collect([snapshot(undefined, [textBlock('hel')]), snapshot(undefined, [textBlock('lo')])]), 'hello');
});

test('suppressed synthetic messages cannot manufacture a new text boundary', () => {
  const text = collect([
    snapshot('one', [textBlock('hel')]),
    {
      type: 'assistant',
      message: { id: 'synthetic', model: '<synthetic>', content: [textBlock('No response requested.')] },
    },
    snapshot('one', [textBlock('lo')]),
  ]);
  assert.equal(text, 'hello');
});

test('background transcript boundaries are independent of tail batch sizes', () => {
  const entries = [snapshot('progress', [textBlock('进度：')]), snapshot('final', [textBlock('@codex\n请处理')])];
  const join = (messages) =>
    messages
      .filter((message) => message.type === 'text')
      .map((message) => message.content)
      .join('');
  const textBoundaryState = {};
  const split = entries.flatMap((entry) =>
    transcriptEntriesToAgentMessages([entry], { catId: 'opus', textBoundaryState }),
  );
  assert.equal(join(split), '进度：\n\n@codex\n请处理');
  assert.equal(join(split), join(transcriptEntriesToAgentMessages(entries, { catId: 'opus' })));
  assert.deepEqual(parseA2AMentions(join(split), 'opus'), ['codex']);
  assert.equal(
    join(transcriptEntriesToAgentMessages([entries[1]], { catId: 'opus', textBoundaryState: {} })),
    '@codex\n请处理',
  );
});

test('id-less legacy events do not invent a boundary from stale known identity', () => {
  assert.equal(
    collect([
      snapshot('first', [textBlock('hel')]),
      snapshot(undefined, [textBlock('lo')]),
      snapshot('last', [textBlock('!')]),
    ]),
    'hello!',
  );
  assert.equal(
    collect([
      snapshot('first', [textBlock('hel')]),
      snapshot('', [textBlock('lo')]),
      snapshot('last', [textBlock('!')]),
    ]),
    'hello!',
  );
});

test('SDK invoke preserves the handoff boundary and resets identity between invocations', async () => {
  const service = new ClaudeSdkAgentService({
    catId: 'opus',
    model: 'claude-test',
    l0CompilerFn: async () => 'test L0',
    queryFn: () => ({
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'boundary-sdk' };
        yield start('progress');
        yield delta('进度：');
        yield stop();
        yield snapshot('progress', [textBlock('进度：')]);
        yield start('final');
        yield delta('@codex\n请处理');
        yield stop();
        yield snapshot('final', [textBlock('@codex\n请处理')]);
        yield { type: 'result', subtype: 'success', session_id: 'boundary-sdk' };
      },
    }),
  });
  for (let invocation = 0; invocation < 2; invocation++) {
    let text = '';
    for await (const message of service.invoke('test', {
      toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    })) {
      if (message.type === 'text') text = accumulateTextAggregate(text, message.content, message.textMode);
    }
    assert.equal(text, '进度：\n\n@codex\n请处理');
    assert.deepEqual(parseA2AMentions(text, 'opus'), ['codex']);
  }
});

test('background invoke retains boundaries across actual file-tail polls, not across invocations', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'f117-boundary-transcript-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const transcript = join(directory, 'transcript.jsonl');
  const progress = snapshot('progress', [textBlock('进度：')]);
  const final = snapshot('final', [textBlock('@codex\n请处理')]);
  const service = new ClaudeBgCarrierService({ model: 'claude-test', pollMs: 1 });
  service.startJob = async () => {
    let poll = 0;
    writeFileSync(transcript, `${JSON.stringify(progress)}\n`);
    return {
      shortId: 'boundary-bg',
      effectiveModel: 'claude-test',
      consumer: {
        async readState() {
          poll++;
          if (poll === 1) return { state: 'working', linkScanPath: transcript };
          writeFileSync(transcript, `${JSON.stringify(progress)}\n${JSON.stringify(final)}\n`);
          return { state: 'done', linkScanPath: transcript, output: { result: '@codex\n请处理' } };
        },
      },
    };
  };
  for (let invocation = 0; invocation < 2; invocation++) {
    let text = '';
    for await (const message of service.invoke('test')) {
      if (message.type === 'text') text = accumulateTextAggregate(text, message.content, message.textMode);
    }
    assert.equal(text, '进度：\n\n@codex\n请处理');
    assert.deepEqual(parseA2AMentions(text, 'opus'), ['codex']);
  }
});
