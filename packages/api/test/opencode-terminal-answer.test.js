import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { accumulateTextAggregate } from '../dist/domains/cats/services/agents/text-aggregation.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  collect,
  createMockProcess,
  emitOpenCodeEvents,
  OMOC_BASH_TOOL,
  OMOC_DELEGATE_ORACLE,
  OMOC_SISYPHUS_TEXT,
  OMOC_STEP_FINISH,
  OMOC_STEP_START,
} from './helpers/opencode-test-helpers.js';

ensureFakeCliOnPath('opencode');

const textEvent = (text) => ({ ...OMOC_SISYPHUS_TEXT, part: { ...OMOC_SISYPHUS_TEXT.part, text } });
const prelude = textEvent('Now I will inspect the search results.');
const answer = textEvent('The available evidence is incomplete; the file read was denied.');
const deniedRead = {
  ...OMOC_BASH_TOOL,
  part: {
    ...OMOC_BASH_TOOL.part,
    tool: 'read',
    state: { status: 'error', input: { filePath: 'results.html' }, error: 'Permission denied' },
  },
};
const toolStepFinish = { ...OMOC_STEP_FINISH, part: { ...OMOC_STEP_FINISH.part, reason: 'tool-calls' } };

const cases = [
  {
    name: 'multiple steps ending in stop',
    events: [
      OMOC_STEP_START,
      prelude,
      OMOC_BASH_TOOL,
      toolStepFinish,
      OMOC_STEP_START,
      prelude,
      deniedRead,
      OMOC_STEP_FINISH,
    ],
  },
  { name: 'delegation ending in stop', events: [OMOC_STEP_START, prelude, OMOC_DELEGATE_ORACLE, OMOC_STEP_FINISH] },
  {
    name: 'earlier delegation followed by another tool',
    events: [OMOC_STEP_START, prelude, OMOC_DELEGATE_ORACLE, prelude, deniedRead, OMOC_STEP_FINISH],
  },
  {
    name: 'whitespace after the last tool',
    events: [OMOC_STEP_START, prelude, deniedRead, textEvent(' \n\t'), OMOC_STEP_FINISH],
  },
];

for (const { name, events } of cases) {
  test(`terminal answer recovery: ${name} cannot substitute for a final answer`, async () => {
    const primary = createMockProcess();
    const finalizer = createMockProcess();
    const spawnFn = mock.fn(() => {
      if (spawnFn.mock.callCount() === 0) return primary;
      process.nextTick(() => emitOpenCodeEvents(finalizer, [OMOC_STEP_START, answer, OMOC_STEP_FINISH]));
      return finalizer;
    });
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'test-model',
      opencodeManagedConfigPaths: [],
    });
    const result = collect(service.invoke('Report your findings, including any limitations.'));
    emitOpenCodeEvents(primary, events);
    const messages = await result;
    const lastText = messages.filter((message) => message.type === 'text').at(-1);
    assert.equal(spawnFn.mock.callCount(), 2, 'a missing final answer requires exactly one bounded recovery');
    assert.equal(lastText?.content, answer.part.text, 'the user must receive findings, not only a progress prelude');
    assert.equal(lastText?.textMode, 'replace');
    const visibleText = messages
      .filter((message) => message.type === 'text')
      .reduce((text, message) => accumulateTextAggregate(text, message.content, message.textMode), '');
    assert.equal(visibleText, answer.part.text, 'the persisted/streamed aggregate must replace the progress prelude');
    assert.equal(JSON.parse(spawnFn.mock.calls[1].arguments[2].env.OPENCODE_PERMISSION)['*'], 'deny');
  });
}

test('terminal answer recovery: actual final text after delegated multi-step work needs no recovery', async () => {
  const primary = createMockProcess();
  const spawnFn = mock.fn(() => primary);
  const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'test-model' });
  const result = collect(service.invoke('Report your findings.'));
  emitOpenCodeEvents(primary, [
    OMOC_STEP_START,
    prelude,
    OMOC_DELEGATE_ORACLE,
    toolStepFinish,
    OMOC_STEP_START,
    OMOC_BASH_TOOL,
    answer,
    OMOC_STEP_FINISH,
  ]);
  const messages = await result;
  assert.equal(spawnFn.mock.callCount(), 1);
  assert.equal(messages.filter((message) => message.type === 'text').at(-1)?.content, answer.part.text);
});

test('terminal answer recovery: whitespace-only finalizer emits an explicit diagnostic', async () => {
  const primary = createMockProcess();
  const finalizer = createMockProcess();
  const spawnFn = mock.fn(() => {
    if (spawnFn.mock.callCount() === 0) return primary;
    process.nextTick(() => emitOpenCodeEvents(finalizer, [OMOC_STEP_START, textEvent(' \n\t'), OMOC_STEP_FINISH]));
    return finalizer;
  });
  const service = new OpenCodeAgentService({
    catId: 'opencode',
    spawnFn,
    model: 'test-model',
    opencodeManagedConfigPaths: [],
  });
  const result = collect(service.invoke('Report your findings.'));
  emitOpenCodeEvents(primary, [OMOC_STEP_START, prelude, deniedRead, toolStepFinish]);
  const messages = await result;
  const lastText = messages.filter((message) => message.type === 'text').at(-1);
  assert.equal(spawnFn.mock.callCount(), 2, 'recovery must remain bounded to one attempt');
  assert.match(lastText?.content ?? '', /did not produce a final text response/);
  assert.equal(lastText?.textMode, 'replace');
});

test('terminal answer recovery: whitespace chunks inside a real final answer are preserved', async () => {
  const primary = createMockProcess();
  const finalizer = createMockProcess();
  const spawnFn = mock.fn(() => {
    if (spawnFn.mock.callCount() === 0) return primary;
    process.nextTick(() =>
      emitOpenCodeEvents(finalizer, [
        OMOC_STEP_START,
        textEvent('Result:'),
        textEvent(' \n'),
        textEvent('Read denied.'),
        OMOC_STEP_FINISH,
      ]),
    );
    return finalizer;
  });
  const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'test-model' });
  const result = collect(service.invoke('Report your findings.'));
  emitOpenCodeEvents(primary, [OMOC_STEP_START, prelude, deniedRead, toolStepFinish]);
  const messages = await result;
  const visibleText = messages
    .filter((message) => message.type === 'text')
    .reduce((text, message) => accumulateTextAggregate(text, message.content, message.textMode), '');
  assert.equal(spawnFn.mock.callCount(), 2);
  assert.equal(visibleText, 'Result: \nRead denied.');
});
