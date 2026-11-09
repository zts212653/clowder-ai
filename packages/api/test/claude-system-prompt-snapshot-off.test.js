/**
 * Claude carriers must opt out of system-prompt recording ("snapshot").
 *
 * Since Claude Code 2.1.318 / @anthropic-ai/claude-agent-sdk 0.3.285 (rolling out
 * per account), a bare-string `systemPrompt` or `--system-prompt[-file]` is
 * rendered on the conversation's first request, recorded in the transcript and
 * resent verbatim on every later `--resume`; a different prompt passed by a
 * later launch is ignored until compaction (sdk.d.ts `systemPrompt.snapshot`).
 * Clowder AI compiles L0 per invocation, so a long-lived resumed thread kept the
 * L0 it was born with: on 2026-11-04 a resumed opus55 session on runtime
 * e067e6f58c still carried the pre-#6557/#6574 L0 while a fresh session got
 * the new one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import {
  prepareClaudeSdkLaunch,
  sdkOperatorArgs,
} from '../dist/domains/cats/services/agents/providers/claude-sdk-launch.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

ensureFakeCliOnPath('claude');

const sessionId = '11111111-1111-4111-8111-111111111111';
const callbackEnv = { CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription' };

test('SDK launch sends L0 as an unrecorded custom prompt, so a resumed session renders the current L0', async () => {
  const launch = await prepareClaudeSdkLaunch({
    runtime: claudeSdkRuntimeFixture(),
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    prompt: 'fixture',
    l0CompilerFn: async () => 'CURRENT-L0-BODY',
    abortController: new AbortController(),
    options: { sessionId, callbackEnv },
  });
  assert.equal(launch.sdkOptions.resume, sessionId);
  const systemPrompt = launch.sdkOptions.systemPrompt;
  assert.equal(
    typeof systemPrompt,
    'object',
    `systemPrompt must not be a bare (recorded) string: ${typeof systemPrompt}`,
  );
  assert.equal(systemPrompt.type, 'custom');
  assert.equal(systemPrompt.snapshot, false);
  assert.match(systemPrompt.prompt, /CURRENT-L0-BODY/);
});

test('SDK operator args cannot turn system-prompt recording back on', () => {
  const { extraArgs } = sdkOperatorArgs(['--system-prompt-snapshot on']);
  assert.equal(Object.hasOwn(extraArgs, 'system-prompt-snapshot'), false);
});

test('print carrier resumes with --system-prompt-snapshot off, and member CLI args cannot override it', async () => {
  const launches = [];
  const service = new ClaudeAgentService({ model: 'claude-opus-4-6', l0CompilerFn: fakeL0Compiler });
  for await (const _ of service.invoke('fixture', {
    sessionId,
    callbackEnv,
    cliConfigArgs: ['--system-prompt-snapshot on'],
    spawnCliOverride: async function* (launch) {
      launches.push([...launch.args]);
      yield { type: 'result', subtype: 'success', session_id: sessionId, result: 'ok' };
    },
  })) {
    /* consume producer */
  }
  assert.equal(launches.length, 1);
  const args = launches[0];
  assert.equal(args[args.indexOf('--resume') + 1], sessionId);
  const flags = args.flatMap((arg, i) => (arg === '--system-prompt-snapshot' ? [args[i + 1]] : []));
  assert.deepEqual(flags, ['off'], `exactly one --system-prompt-snapshot off expected: ${args.join(' ')}`);
});
