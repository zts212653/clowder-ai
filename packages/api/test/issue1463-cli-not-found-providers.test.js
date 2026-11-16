/** #1463 S3: exercise real providers and consumers, without starting an agent CLI. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { evaluate, resetDedup } from '../dist/domains/cats/services/frustration/FrustrationDetector.js';
import { InMemoryFrustrationIssueStore } from '../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js';
import { invalidateCliCommand, resolveCliCommand } from '../dist/utils/cli-resolve.js';

const fakeL0 = async ({ outPath } = {}) => {
  if (outPath) writeFileSync(outPath, '# Identity\nFixture cat.');
  return '# Identity\nFixture cat.';
};

function isolateMissingCli(t, command) {
  const root = mkdtempSync(join(tmpdir(), 'issue1463-provider-'));
  const keys = ['HOME', 'USERPROFILE', 'PATH', 'Path', 'APPDATA', 'LOCALAPPDATA', 'KIMI_CODE_HOME'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const name of [command, 'kimi-cli']) invalidateCliCommand(name);
    rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  // Retain OS identity tools for AGY's process-ownership fence. No user bin directories.
  process.env.PATH =
    process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin';
  process.env.Path = process.env.PATH;
  process.env.APPDATA = join(root, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = join(root, 'AppData', 'Local');
  process.env.KIMI_CODE_HOME = join(root, '.kimi-code');
  for (const name of [command, 'kimi-cli']) {
    invalidateCliCommand(name);
    assert.equal(resolveCliCommand(name), null, `fixture must have no ${name}`);
  }
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return { root, workspace };
}

function assertStructuredError(events, command) {
  const errors = events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(events.at(-1).type, 'done');
  const diagnostic = errors[0].metadata?.cliDiagnostics;
  assert.ok(diagnostic, JSON.stringify(errors[0]));
  assert.equal(diagnostic.reasonCode, 'cli_not_found');
  assert.equal(diagnostic.debugRef.command, command);
  assert.equal(Object.hasOwn(diagnostic.debugRef, 'exitCode'), false);
  assert.equal(diagnostic.debugRef.signal, null);
  assert.equal(diagnostic.safeExcerpt, undefined);
  return diagnostic;
}

test('an installed CLI outside the current search path offers configuration checks before optional installation', async (t) => {
  const { root, workspace } = isolateMissingCli(t, 'kimi');
  const privateBin = join(root, 'private-install');
  mkdirSync(privateBin);
  const binary = join(privateBin, process.platform === 'win32' ? 'kimi.cmd' : 'kimi');
  writeFileSync(binary, process.platform === 'win32' ? '@exit /b 91\n' : '#!/bin/sh\nexit 91\n');
  chmodSync(binary, 0o700);
  assert.equal(existsSync(binary), true, 'the CLI is installed outside the resolver search locations');
  assert.equal(resolveCliCommand('kimi'), null, 'current execution context still cannot resolve it');
  const catId = 'issue1463-path-only';
  catRegistry.register(catId, {
    id: catId,
    name: catId,
    displayName: catId,
    clientId: 'kimi',
    carrier: 'cli',
    configurationSource: 'native_tool',
    defaultModel: '',
    cli: { command: 'kimi', outputFormat: 'stream-json' },
  });
  let spawnCalls = 0;
  const service = new KimiAgentService({
    catId,
    model: '',
    spawnFn: () => {
      spawnCalls++;
      throw new Error('unresolved CLI must not spawn');
    },
  });
  const events = await Array.fromAsync(service.invoke('fixture only', { workingDirectory: workspace }));
  assert.equal(spawnCalls, 0);
  const diagnostic = assertStructuredError(events, 'kimi');
  const textError = events.find((event) => event.type === 'error').error;
  for (const copy of [textError, diagnostic.publicHint]) {
    assert.match(copy, /当前执行环境.*PATH.*CLI 命令配置/);
    assert.match(copy, /若尚未安装/);
    assert.match(copy, /kimi-code\/install/);
    assert.equal(copy.includes(privateBin), false);
  }
  assert.equal(existsSync(binary), true, 'diagnostic must not alter the installed binary');
});

async function assertAutoIssueBoundary(diagnostic) {
  resetDedup();
  const store = new InMemoryFrustrationIssueStore();
  const messages = [];
  const broadcasts = [];
  const deps = {
    frustrationIssueStore: store,
    messageStore: {
      getByThread: () => [],
      append: (message) => {
        messages.push(message);
        return { ...message, id: 'fixture' };
      },
    },
    socketManager: { broadcastToRoom: (...args) => broadcasts.push(args) },
  };
  const context = { userId: 'fixture-user', catId: 'codex' };
  const missing = await evaluate(
    {
      ...context,
      threadId: 'issue1463-missing',
      signal: { type: 'cli_error', diagnostics: diagnostic },
    },
    deps,
  );
  assert.equal(missing, null);
  assert.deepEqual(await store.listByThread('issue1463-missing'), []);
  assert.deepEqual(messages, []);
  assert.deepEqual(broadcasts, []);
  const spawned = await evaluate(
    {
      ...context,
      threadId: 'issue1463-spawn',
      signal: {
        type: 'cli_error',
        diagnostics: {
          reasonCode: 'spawn_failed',
          publicSummary: 'fixture spawn failure',
          publicHint: 'fixture only',
          debugRef: { command: 'codex', signal: null },
        },
      },
    },
    deps,
  );
  assert.ok(spawned, 'actual spawn failure must retain its issue semantics');
  assert.equal((await store.listByThread('issue1463-spawn')).length, 1);
  assert.equal(messages.length, 1);
}

for (const [command, Service, clientId, model] of [
  ['claude', ClaudeAgentService, 'anthropic', 'claude-fixture'],
  ['codex', CodexAgentService, 'openai', 'gpt-5.3-codex'],
  ['kimi', KimiAgentService, 'kimi', ''],
  ['opencode', OpenCodeAgentService, 'opencode', 'fixture/model'],
]) {
  test(`${command}: missing CLI survives error→done without spawn`, async (t) => {
    const { workspace } = isolateMissingCli(t, command);
    const id = `issue1463-actual-${command}`;
    catRegistry.register(id, {
      id,
      name: id,
      displayName: id,
      clientId,
      carrier: 'cli',
      configurationSource: 'native_tool',
      defaultModel: model,
      cli: { command, outputFormat: 'stream-json' },
    });
    let spawnCalls = 0;
    const service = new Service({
      catId: id,
      model,
      l0CompilerFn: fakeL0,
      spawnFn: () => {
        spawnCalls++;
        throw new Error('missing CLI must not spawn');
      },
      rawArchive: { append: async () => {} },
    });
    const events = await Array.fromAsync(
      service.invoke('fixture only', {
        workingDirectory: workspace,
        invocationId: id,
      }),
    );
    assert.equal(spawnCalls, 0);
    const diagnostic = assertStructuredError(events, command);
    // Consume this invocation's result directly; no dependency on another test's success.
    if (command === 'kimi') await assertAutoIssueBoundary(diagnostic);
  });
}

test('AGY: actual prepare throw/caller catch carries cli_not_found', async (t) => {
  const { root, workspace } = isolateMissingCli(t, 'agy');
  let spawnCalls = 0;
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: { enabled: true, autoApprove: true, model: 'gemini-4-argon-high', homeRoot: join(root, 'profiles') },
    l0CompilerFn: fakeL0,
    rawArchive: { append: async () => {} },
  });
  const events = await Array.fromAsync(
    service.invoke('fixture only', {
      workingDirectory: workspace,
      invocationId: 'issue1463-agy',
      spawnCliOverride: async function* () {
        spawnCalls++;
        yield { event: 'result', result: { status: 'ERROR', error: 'unexpected spawn', num_turns: 0 } };
      },
    }),
  );
  assert.equal(spawnCalls, 0);
  assertStructuredError(events, 'agy');
});
