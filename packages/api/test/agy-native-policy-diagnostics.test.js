import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isConfirmedNativeAuthFailure } from '../dist/domains/cats/services/agents/invocation/native-auth-continuation.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { projectAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { summarizeAgyStreamJsonTurn } from '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js';
import { buildCliDiagnostics } from '../dist/utils/cli-diagnostics.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

// Exact provider wording from human3195's two AGY failures; no model or private reasoning needed.
const policyError =
  'Your previous response was blocked by content safety filters\nOutput retries exhausted after 4 attempts';
const summary = '上游内容安全策略拦截了本次调用';

test('AGY policy rejection is classified, humanized, bounded and sanitized', () => {
  const diagnostics = buildCliDiagnostics({
    rawText: `${policyError}\nAuthorization: Bearer fixture-secret-do-not-expose\nconfig=/srv/private/session.json`,
    debugRef: { command: 'agy', exitCode: 3, signal: null, invocationId: 'policy-fixture' },
  });
  assert.equal(diagnostics.reasonCode, 'upstream_policy_reject');
  assert.equal(diagnostics.publicSummary, summary);
  assert.match(diagnostics.safeExcerpt, /Output retries exhausted after 4 attempts/);
  assert.doesNotMatch(diagnostics.safeExcerpt, /fixture-secret-do-not-expose|\/srv\/private/);
  assert.doesNotMatch(diagnostics.publicHint, /换.*provider|重试 prompt|Google|Anthropic/);
});

for (const [error, expectedReason, expectedText, stderr = true] of [
  [policyError, 'upstream_policy_reject', summary],
  [policyError, 'upstream_policy_reject', summary, false],
  ['some unrecognized provider failure', undefined, 'CLI 异常退出'],
  ['401 UNAUTHENTICATED', 'auth_failed', 'API 认证失败'],
  ['401 UNAUTHENTICATED', undefined, 'CLI 异常退出', false],
]) {
  test(`verified AGY failure presents ${expectedReason ?? 'unknown'} with stderr=${stderr}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'native-error-copy-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const script = join(root, 'provider.cjs');
    const service = new AgyNativeAgentService({
      catId: 'gemini38',
      command: '/usr/bin/true',
      profile: { enabled: true, autoApprove: true, model: 'gemini-3.8-flash-high', homeRoot: join(root, 'profile') },
      l0CompilerFn: async () => '# Fixture',
      rawArchive: { append: async () => {} },
    });
    const messages = [];
    for await (const message of service.invoke('fixture', {
      workingDirectory: workspace,
      invocationId: 'policy-fixture',
      spawnCliOverride(launch) {
        const events = [
          {
            event: 'init',
            conversation_id: 'policy-session',
            init: {
              cwd: launch.cwd,
              agent: launch.args[launch.args.indexOf('--agent') + 1],
              model: 'gemini-3.8-flash-high',
              permission_mode: 'always-proceed',
            },
          },
          { event: 'result', result: { conversation_id: 'policy-session', status: 'ERROR', response: '', error } },
        ];
        writeFileSync(
          script,
          `process.stdout.write(${JSON.stringify(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)});` +
            `process.stderr.write(${JSON.stringify(stderr ? error : '')}); process.exitCode = 3;`,
        );
        return spawnCli({ ...launch, command: process.execPath, args: [script] });
      },
    }))
      messages.push(message);
    const failure = messages.find((m) => m.type === 'error');
    assert.ok(failure);
    assert.equal(failure.errorCode, 'AGY_NATIVE_FAILED');
    assert.match(failure.error, new RegExp(expectedText));
    assert.equal(failure.metadata.cliDiagnostics.reasonCode, expectedReason);
    assert.equal(failure.metadata.cliDiagnostics.debugRef.exitCode, 3);
    assert.equal(failure.metadata.cliDiagnostics.debugRef.invocationId, 'policy-fixture');
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
    assert.equal(isConfirmedNativeAuthFailure(failure), expectedReason === 'auth_failed');
  });
}

for (const cancelled of [false, true]) {
  test(`classified transport cannot override permission/cancellation: cancelled=${cancelled}`, () => {
    const transportError = 'CLI 异常退出 (code: 3, signal: none)';
    const turn = summarizeAgyStreamJsonTurn([
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'policy-session',
          status: 'SUCCESS',
          response: '',
          denied_actions: [{ action: 'run_command' }],
        },
      }),
    ]);
    const failure = projectAgyNativeTurn(
      'gemini38',
      { provider: 'google', model: 'fixture' },
      {
        sessionId: 'policy-session',
        turn,
        transportError,
        cliDiagnostics: buildCliDiagnostics({
          rawText: '401 UNAUTHENTICATED',
          debugRef: { command: 'agy', exitCode: 3, signal: null },
        }),
      },
      cancelled,
    ).find((message) => message.type === 'error');
    assert.ok(failure);
    assert.equal(failure.errorCode, cancelled ? 'AGY_CANCELLED' : 'AGY_PERMISSION_DENIED');
    assert.equal(
      failure.error,
      cancelled ? 'AGY native turn was cancelled before its terminal result' : transportError,
    );
    assert.equal(isConfirmedNativeAuthFailure(failure), false);
  });
}
