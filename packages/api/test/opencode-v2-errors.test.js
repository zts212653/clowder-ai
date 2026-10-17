import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { transformOpenCodeEvent } from '../dist/domains/cats/services/agents/providers/opencode-event-transform.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('opencode');
test('v2 error messages survive mapping, while secrets and response bodies never surface', () => {
  const secret = 'sk-FixturePrivateToken01234567890123456789';
  for (const error of [
    { type: 'provider.auth', message: `401 Unauthorized ${secret}`, status: 401, response: { body: 'PRIVATE_BODY' } },
    { name: 'APIError', data: { message: `401 Unauthorized ${secret}`, statusCode: 401 }, response: 'PRIVATE_BODY' },
  ]) {
    const result = transformOpenCodeEvent({ type: 'error', error }, 'opencode');
    assert.match(result?.error ?? '', /401 Unauthorized/);
    assert.doesNotMatch(JSON.stringify(result), /FixturePrivateToken|PRIVATE_BODY/);
  }
  assert.equal(
    transformOpenCodeEvent({ type: 'error', error: { message: { private: 'PRIVATE_BODY' } } }, 'opencode')?.error,
    'opencode error',
  );
});

for (const version of ['v1', 'v2', 'v2-auth-without-status']) {
  const v2 = version !== 'v1';
  test(`actual ${version} NDJSON error is classified and stops the owned CLI without changing the model`, async () => {
    const error = v2
      ? { type: 'provider.auth', message: 'Provider denied access', ...(version === 'v2' ? { status: 401 } : {}) }
      : { name: 'APIError', data: { message: 'Provider denied access', statusCode: 401 } };
    let child;
    let invokedArgs;
    const service = new OpenCodeAgentService({
      catId: 'opencode-v2-fixture',
      model: 'kitcoding/gpt-6.1-sol',
      rawArchive: { async append() {} },
      spawnFn(_command, args, options) {
        invokedArgs = args;
        const source = `console.log(${JSON.stringify(JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'fixture', error }))});setInterval(()=>{},1000);`;
        child = spawn(process.execPath, ['-e', source], { ...options, windowsHide: true });
        return child;
      },
    });
    const collect = (async () => {
      const messages = [];
      for await (const item of service.invoke('fixture')) messages.push(item);
      return messages;
    })();
    let timer;
    try {
      const messages = await Promise.race([
        collect,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('permanent provider failure did not stop')), 4_000);
        }),
      ]);
      const failure = messages.find((message) => message.type === 'error');
      assert.equal(failure?.error, 'Provider denied access');
      assert.equal(failure?.metadata?.cliDiagnostics?.reasonCode, 'auth_failed');
      assert.equal(
        messages.some((message) => message.type === 'text'),
        false,
      );
      assert.equal(invokedArgs[invokedArgs.indexOf('-m') + 1], 'kitcoding/gpt-6.1-sol');
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await collect.catch(() => {});
    }
  });
}

test('v2 transient status preserves a recovering stream', async () => {
  const events = [
    {
      type: 'error',
      timestamp: 1,
      sessionID: 'fixture',
      error: { type: 'provider.internal', message: 'Temporary provider outage', status: 503 },
    },
    { type: 'text', timestamp: 2, sessionID: 'fixture', part: { type: 'text', text: 'RECOVERED' } },
  ];
  const service = new OpenCodeAgentService({
    catId: 'opencode-v2-fixture',
    model: 'kitcoding/gpt-6.1-sol',
    rawArchive: { async append() {} },
    spawnFn(_command, _args, options) {
      return spawn(
        process.execPath,
        ['-e', `for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`],
        { ...options, windowsHide: true },
      );
    },
  });
  const messages = [];
  for await (const message of service.invoke('fixture')) messages.push(message);
  assert.equal(messages.find((message) => message.type === 'error')?.error, 'Temporary provider outage');
  assert.equal(messages.find((message) => message.type === 'text')?.content, 'RECOVERED');
});

for (const version of ['v1', 'v2']) {
  test(`${version} permanent authentication failure terminates the owned no-tool finalizer`, async () => {
    const error =
      version === 'v2'
        ? { type: 'provider.auth', message: 'Provider denied access', status: 401 }
        : { name: 'APIError', data: { message: 'Provider denied access', statusCode: 401 } };
    let child;
    let invokedArgs;
    let invokedEnv;
    const service = new OpenCodeAgentService({
      catId: 'opencode-finalizer-fixture',
      model: 'fixture/unchanged',
      opencodeManagedConfigPaths: [],
      rawArchive: { async append() {} },
      spawnFn(_command, args, options) {
        invokedArgs = args;
        invokedEnv = options.env;
        const source = `console.log(${JSON.stringify(JSON.stringify({ type: 'error', error }))});setInterval(()=>{},1000);`;
        child = spawn(process.execPath, ['-e', source], { ...options, windowsHide: true });
        return child;
      },
    });
    const collect = (async () => {
      const messages = [];
      for await (const message of service.runPostToolFinalizer({
        command: 'fixture-only',
        childEnv: {},
        effectiveModel: 'fixture/unchanged',
        metadata: { provider: 'opencode', model: 'fixture/unchanged' },
        trace: null,
        textMode: 'replace',
      }))
        messages.push(message);
      if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      return messages;
    })();
    let timer;
    try {
      const messages = await Promise.race([
        collect,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('permanent finalizer error did not stop')), 4_000);
        }),
      ]);
      assert.ok(child && (child.exitCode !== null || child.signalCode !== null));
      assert.ok(invokedArgs.includes('--pure'), 'no-tool permission boundary must stay intact');
      assert.equal(invokedArgs[invokedArgs.indexOf('-m') + 1], 'fixture/unchanged');
      assert.equal(JSON.parse(invokedEnv.OPENCODE_PERMISSION)['*'], 'deny');
      assert.equal(messages.at(-1)?.textMode, 'replace');
      assert.match(messages.at(-1)?.content ?? '', /provider_error/);
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await collect.catch(() => {});
    }
  });
}

test('a transient finalizer error keeps draining the process but still returns the safe fallback', async () => {
  let child;
  const error = { type: 'error', error: { type: 'provider.internal', message: 'Provider recovering', status: 503 } };
  const text = { type: 'text', part: { type: 'text', text: 'DO_NOT_ACCEPT_POISONED_TEXT' } };
  const service = new OpenCodeAgentService({
    catId: 'opencode-finalizer-fixture',
    model: 'fixture/unchanged',
    opencodeManagedConfigPaths: [],
    rawArchive: { async append() {} },
    spawnFn(_command, _args, options) {
      const source = `console.log(${JSON.stringify(JSON.stringify(error))});setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(text))}),30);`;
      child = spawn(process.execPath, ['-e', source], { ...options, windowsHide: true });
      return child;
    },
  });
  const messages = [];
  for await (const message of service.runPostToolFinalizer({
    command: 'fixture-only',
    childEnv: {},
    effectiveModel: 'fixture/unchanged',
    metadata: { provider: 'opencode', model: 'fixture/unchanged' },
    trace: null,
    textMode: 'replace',
  }))
    messages.push(message);
  assert.equal(child.exitCode, 0, 'transient provider error must not kill the process');
  assert.equal(
    messages.some((message) => message.content === 'DO_NOT_ACCEPT_POISONED_TEXT'),
    false,
  );
  assert.match(messages.at(-1)?.content ?? '', /provider_error/);
});
