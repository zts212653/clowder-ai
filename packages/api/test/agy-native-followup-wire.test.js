import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

test('real stream-json child and Queue deliver A then B once in one process', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-followup-wire-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = 'gemini-3.8-flash-high';
  let dispatcher;
  let spawned = 0;
  let delivery;
  const history = [];
  const queue = await appendRecoveryFixture((input, control) => dispatcher.dispatch(input, control), {
    inputCompletionReceipt: true,
  });
  const script = `
    const readline = require('node:readline');
    const [agent, cwd, model] = process.argv.slice(1);
    const send = (x) => process.stdout.write(JSON.stringify(x)+'\\n');
    send({event:'init',conversation_id:'wire',init:{agent,cwd,model,permission_mode:'request-review',tools:[]}});
    let chain = Promise.resolve();
    let index = 0;
    const reader = readline.createInterface({input:process.stdin});
    reader.on('line', (line) => {
      const body = JSON.parse(line).message.content[0].text;
      chain = chain.then(async () => {
        const step = index;
        index += 2;
        send({event:'step_update',step_update:{conversation_id:'wire',step_index:step,step_type:'user_input',state:'DONE'}});
        await new Promise((done) => setTimeout(done,100));
        const text = body === 'A' ? 'A done.' : 'B done.';
        send({event:'step_update',step_update:{conversation_id:'wire',step_index:step+1,step_type:'agent_response',state:'DONE',text_delta:text}});
        send({event:'result',result:{conversation_id:'wire',status:'SUCCESS',response:text,num_turns:index/2}});
      });
    });
  `;
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: process.execPath,
    l0CompilerFn: async () => '# Native fixture',
    rawArchive: { append: async (_id, event) => history.push(event) },
    profile: {
      enabled: true,
      profileId: 'gemini38',
      model,
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  try {
    const messages = [];
    for await (const message of service.invoke('A', {
      invocationId: 'turn',
      workingDirectory: workspace,
      activeRunDispatch: {
        invocationId: 'turn',
        register: (value) => {
          dispatcher = value;
          delivery = value.initialInputRead.then(async () => {
            assert.equal(history.filter((x) => x.event === 'result').length, 0);
            const result = await queue.append();
            assert.equal(queue.queue.list('thread', 'owner').length, 1);
            return result;
          });
        },
      },
      spawnCliOverride: (launch) => {
        spawned++;
        return spawnCli({
          ...launch,
          command: process.execPath,
          args: ['-e', script, launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, model],
          timeoutMs: 4000,
        });
      },
    }))
      messages.push(message);
    assert.equal((await delivery).outcome, 'appended');
    assert.equal(spawned, 1);
    assert.equal(history.filter((x) => x.event === 'init').length, 1);
    assert.equal(history.filter((x) => x.event === 'result').length, 2);
    assert.equal(
      messages
        .filter((x) => x.type === 'text')
        .map((x) => x.content)
        .join(''),
      'A done.B done.',
    );
    assert.equal(messages.filter((x) => x.type === 'done').length, 1);
    assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
    assert.equal(queue.queue.list('thread', 'owner').length, 0);
    assert.equal(
      (await queue.messageStore.getById(queue.admission.message.id)).lifecycle.dispatchRefs[0].appendAcceptance,
      'accepted',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real stream-json child and Queue complete recovered A before B', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-followup-wire-recovered-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = 'gemini-3.8-flash-high';
  const recovered = readFileSync(
    new URL('./fixtures/agy-stream-json/recovered-retry-turn.ndjson', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  let dispatcher;
  let spawned = 0;
  let delivery;
  const history = [];
  const queue = await appendRecoveryFixture((input, control) => dispatcher.dispatch(input, control), {
    inputCompletionReceipt: true,
  });
  const script = `
    const readline = require('node:readline');
    const [agent, cwd, model] = process.argv.slice(1);
    const recovered = ${JSON.stringify(recovered)};
    const send = (x) => process.stdout.write(JSON.stringify(x)+'\\n');
    send({event:'init',conversation_id:'wire',init:{agent,cwd,model,permission_mode:'request-review',tools:[]}});
    let chain = Promise.resolve();
    const reader = readline.createInterface({input:process.stdin});
    reader.on('line', (line) => {
      const body = JSON.parse(line).message.content[0].text;
      chain = chain.then(async () => {
        if (body === 'A') {
          for (const event of recovered) {
            if (event.event === 'init') continue;
            if (event.event === 'step_update') event.step_update.conversation_id = 'wire';
            if (event.event === 'result') {
              event.result.conversation_id = 'wire';
              await new Promise((done) => setTimeout(done,100));
            }
            send(event);
          }
          return;
        }
        send({event:'step_update',step_update:{conversation_id:'wire',step_index:94,step_type:'user_input',state:'DONE'}});
        await new Promise((done) => setTimeout(done,100));
        send({event:'step_update',step_update:{conversation_id:'wire',step_index:95,step_type:'agent_response',state:'DONE',text_delta:'B done.'}});
        send({event:'result',result:{conversation_id:'wire',status:'SUCCESS',response:'B done.',num_turns:2}});
      });
    });
  `;
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: process.execPath,
    l0CompilerFn: async () => '# Native fixture',
    rawArchive: { append: async (_id, event) => history.push(event) },
    profile: {
      enabled: true,
      profileId: 'gemini38',
      model,
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  try {
    const messages = [];
    for await (const message of service.invoke('A', {
      invocationId: 'turn',
      workingDirectory: workspace,
      activeRunDispatch: {
        invocationId: 'turn',
        register: (value) => {
          dispatcher = value;
          delivery = value.initialInputRead.then(async () => {
            assert.equal(history.filter((x) => x.event === 'result').length, 0);
            const result = await queue.append();
            assert.equal(queue.queue.list('thread', 'owner').length, 1);
            return result;
          });
        },
      },
      spawnCliOverride: (launch) => {
        spawned++;
        return spawnCli({
          ...launch,
          command: process.execPath,
          args: ['-e', script, launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, model],
          timeoutMs: 4000,
        });
      },
    }))
      messages.push(message);
    assert.equal((await delivery).outcome, 'appended');
    assert.equal(spawned, 1);
    assert.deepEqual(
      history.filter((x) => x.event === 'result').map((x) => x.result.status),
      ['ERROR', 'SUCCESS'],
    );
    assert.equal(
      messages
        .filter((x) => x.type === 'text')
        .map((x) => x.content)
        .join(''),
      'Recovered review\nB done.',
    );
    assert.equal(messages.filter((x) => x.type === 'done').length, 1);
    assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
    assert.equal(queue.queue.list('thread', 'owner').length, 0);
    assert.equal(
      (await queue.messageStore.getById(queue.admission.message.id)).lifecycle.dispatchRefs[0].appendAcceptance,
      'accepted',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
