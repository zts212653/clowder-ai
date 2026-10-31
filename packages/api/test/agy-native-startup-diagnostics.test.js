import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isConfirmedNativeAuthFailure } from '../dist/domains/cats/services/agents/invocation/native-auth-continuation.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import {
  projectAgyNativeTurn,
  readAgyNativeTurn,
} from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

// Exact failure shape from the Argon welcome invocation: result ERROR before init.
const model = 'gemini-4-argon-high';
const rejection = `invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)`;
const invocationId = 'f325-startup-diagnostics';
const result = { event: 'result', result: { conversation_id: '', status: 'ERROR', error: rejection, num_turns: 0 } };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-startup-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: { enabled: true, autoApprove: true, model, homeRoot: join(root, 'profiles') },
    l0CompilerFn: async () => '# Identity\nFixture cat.',
    rawArchive: { append: async () => {} },
  });
  return {
    root,
    async run(spawnCliOverride, signal) {
      const messages = [];
      const promptWrites = [];
      let settleCalls = 0;
      for await (const message of service.invokeWithContinuityPreflight(
        {
          settle: async () => {
            settleCalls++;
            return { prompt: 'startup must not submit this prompt', promptGenerationId: 'startup-generation' };
          },
        },
        {
          workingDirectory: workspace,
          invocationId,
          spawnCliOverride: (launch) => spawnCliOverride(launch, (value) => promptWrites.push(value)),
          ...(signal ? { signal } : {}),
        },
      ))
        messages.push(message);
      // The service catches provider errors; an assertion inside settle alone can be swallowed.
      assert.deepEqual(
        { settleCalls, promptWrites },
        { settleCalls: 0, promptWrites: [] },
        'no generation may settle or write a prompt after an unverified startup result',
      );
      assert.equal(messages.filter((m) => m.type === 'error').length, 1);
      assert.equal(messages.filter((m) => m.type === 'done').length, 1);
      assert.equal(
        messages.some((m) => m.type === 'session_init' || m.type === 'text'),
        false,
      );
      const failure = messages.find((m) => m.type === 'error');
      assert.equal(isConfirmedNativeAuthFailure(failure), false, 'startup diagnostics never authorize continuation');
      return failure;
    },
  };
}

for (const stderr of [true, false])
  test(`Native preserves model rejection through spawn with stderr=${stderr}`, async (t) => {
    const f = fixture(t);
    const script = join(f.root, 'rejected-provider.cjs');
    writeFileSync(
      script,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)}); ${stderr ? `process.stderr.write(${JSON.stringify(rejection)});` : ''} process.exitCode = 1;`,
    );
    const failure = await f.run((launch) => spawnCli({ ...launch, command: process.execPath, args: [script] }));
    assert.equal(failure.metadata.cliDiagnostics?.reasonCode, 'model_not_found');
    assert.equal(failure.error, '模型名不被支持');
    assert.equal(failure.metadata.cliDiagnostics.debugRef.invocationId, invocationId);
    assert.equal(failure.metadata.cliDiagnostics.debugRef.exitCode, 1);
    assert.match(failure.metadata.cliDiagnostics.safeExcerpt, /gemini-4-argon-high/);
  });

test('a result-only startup rejection retains the provider reason without inventing an exit code', async (t) => {
  const f = fixture(t);
  const failure = await f.run(async function* () {
    yield result;
  });
  assert.equal(failure.metadata.cliDiagnostics?.reasonCode, 'model_not_found');
  assert.equal(failure.metadata.cliDiagnostics.debugRef.invocationId, invocationId);
  assert.equal(failure.metadata.cliDiagnostics.debugRef.exitCode, undefined);
});

for (const [error, reasonCode] of [
  ['401 UNAUTHENTICATED', 'auth_failed'],
  ['connect ECONNREFUSED', 'network_error'],
]) {
  test(`pre-init ${reasonCode} stays diagnostic-only even with a claimed conversation and exit 3`, async (t) => {
    const failure = await fixture(t).run(async function* () {
      yield { event: 'result', result: { conversation_id: 'unverified-session', status: 'ERROR', error } };
      yield { __cliError: true, command: 'agy', message: 'CLI exit 3', exitCode: 3, signal: null };
    });
    assert.equal(failure.metadata.cliDiagnostics?.reasonCode, reasonCode);
    assert.equal(failure.metadata.cliDiagnostics.debugRef.exitCode, 3);
    assert.equal(failure.metadata.sessionId, undefined);
    assert.equal(failure.metadata.diagnostics?.agyNative?.toolResultsConfirmed, undefined);
  });
}

test('a result-only SUCCESS cannot establish a session or deliver its response', async (t) => {
  const failure = await fixture(t).run(async function* () {
    yield { event: 'result', result: { conversation_id: 'unverified-session', status: 'SUCCESS', response: 'done' } };
  });
  assert.equal(failure.errorCode, 'AGY_NATIVE_PREFLIGHT');
  assert.equal(failure.metadata.cliDiagnostics, undefined);
});

for (const status of ['ERROR', 'SUCCESS']) {
  test(`init after a pre-init ${status} result cannot settle or submit a prompt`, async (t) => {
    await fixture(t).run(async function* (launch, recordPrompt) {
      launch.onStdinReady(recordPrompt);
      yield { event: 'result', result: { conversation_id: 'late-session', status, error: rejection } };
      yield {
        event: 'init',
        conversation_id: 'late-session',
        init: {
          agent: launch.args[launch.args.indexOf('--agent') + 1],
          cwd: launch.cwd,
          model,
          permission_mode: 'always-proceed',
        },
      };
      yield { event: 'result', result: { conversation_id: 'late-session', status: 'SUCCESS', response: 'done' } };
    });
  });
}

test('cancellation still wins over a pre-init provider rejection', async (t) => {
  const controller = new AbortController();
  const failure = await fixture(t).run(async function* () {
    yield result;
    controller.abort();
  }, controller.signal);
  assert.equal(failure.errorCode, 'AGY_CANCELLED');
  assert.equal(failure.metadata.cliDiagnostics, undefined);
});

test('pre-init timeout retains causal diagnostics and cancellation still wins', async (t) => {
  const f = fixture(t);
  const diagnostics = {
    publicSummary: 'CLI 响应超时',
    publicHint: 'fixture timeout',
    reasonCode: 'cli_response_timeout',
    debugRef: { command: 'agy', signal: null, invocationId },
  };
  async function* timeout() {
    yield {
      __cliTimeout: true,
      timeoutMs: 1000,
      command: 'agy',
      message: 'CLI response timed out',
      cliDiagnostics: diagnostics,
    };
  }
  const failure = await f.run(timeout);
  assert.deepEqual(failure.metadata.cliDiagnostics, diagnostics);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await f.run(timeout, controller.signal);
  assert.equal(cancelled.errorCode, 'AGY_CANCELLED');
  assert.equal(cancelled.metadata.cliDiagnostics, undefined);
});

test('empty startup still refuses unverifiable success', async (t) => {
  const failure = await fixture(t).run(async function* () {});
  assert.match(failure.error, /without a verified init/);
  assert.equal(failure.metadata.cliDiagnostics, undefined);
});

test('startup provider diagnostics are sanitized before they reach user metadata', async (t) => {
  const f = fixture(t);
  const failure = await f.run(async function* () {
    yield {
      event: 'result',
      result: {
        status: 'ERROR',
        error:
          'model unknown is not recognized as a known model or custom model in settings\nAuthorization: Bearer fixture-secret-do-not-expose',
      },
    };
  });
  assert.equal(failure.metadata.cliDiagnostics?.reasonCode, 'model_not_found');
  assert.doesNotMatch(JSON.stringify(failure), /fixture-secret-do-not-expose/);
});

test('transport diagnostics also survive an error after verified init', async () => {
  const diagnostics = {
    publicSummary: '网络连接失败',
    publicHint: 'fixture network',
    reasonCode: 'network_error',
    debugRef: { command: 'agy', signal: null, exitCode: 1, invocationId },
  };
  async function* stream() {
    yield {
      event: 'init',
      conversation_id: 'network-session',
      init: { agent: 'fixture', cwd: '/tmp', model, permission_mode: 'request-review' },
    };
    yield {
      __cliError: true,
      exitCode: 1,
      signal: null,
      command: 'agy',
      message: 'network failed',
      cliDiagnostics: diagnostics,
    };
  }
  const observed = await readAgyNativeTurn(stream(), { agentName: 'fixture', spawnCwd: '/tmp', model });
  const messages = projectAgyNativeTurn('gemini38', { provider: 'google', model }, observed, false);
  assert.deepEqual(messages.find((m) => m.type === 'error')?.metadata.cliDiagnostics, diagnostics);
  assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
});
