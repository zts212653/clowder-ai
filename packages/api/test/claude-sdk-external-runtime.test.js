import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { prepareClaudeSdkLaunch } from '../dist/domains/cats/services/agents/providers/claude-sdk-launch.js';
import { captureClaudeSdkRuntime } from '../dist/domains/cats/services/agents/providers/claude-sdk-runtime.js';

test('SDK launch consumes the frozen external program instead of its bundled executable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-external-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'cli.js');
  const body = 'console.log("external fixture")';
  writeFileSync(file, body);
  const claudeSdkRuntime = Object.freeze({
    path: file,
    executable: process.execPath,
    version: '2.1.312',
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  const prepare = () =>
    prepareClaudeSdkLaunch({
      catId: 'opus',
      model: 'fixture',
      prompt: 'check',
      l0CompilerFn: async () => 'identity',
      abortController: new AbortController(),
      options: { toolExecutionPolicy: { mode: 'read_only' }, claudeSdkRuntime },
    });
  const first = await prepare();
  assert.equal(first.sdkOptions.pathToClaudeCodeExecutable, file);
  assert.equal(first.sdkOptions.executable, 'node');
  writeFileSync(file, 'replaced at the same path');
  await assert.rejects(prepare(), /claude_runtime_changed/);
});

test('missing external Claude is actionable before any SDK/model call', async () => {
  await assert.rejects(
    () => captureClaudeSdkRuntime(join(tmpdir(), 'not-installed-claude-1748')),
    /claude_runtime_missing.*安装/,
  );
});

test(
  'the real SDK without native packages runs an external program through the product carrier',
  { timeout: 20000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-library-only-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
    const sdkRoot = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
    const library = join(root, 'sdk');
    cpSync(sdkRoot, library, {
      recursive: true,
      filter: (file) => !file.slice(sdkRoot.length).split(/[\\/]/).includes('node_modules'),
    });
    assert.equal(
      readdirSync(library, { recursive: true }).some((name) => /\.(exe|node)$/.test(name)),
      false,
    );
    const { query, getSessionInfo } = await import(pathToFileURL(join(library, 'sdk.mjs')).href);
    assert.equal(await getSessionInfo('ab37caa9-4d73-4ef3-a969-a1f58cc00ced', { dir: root }), undefined);
    const executable = join(root, 'external-cli.js');
    cpSync(fileURLToPath(new URL('./fixtures/fake-claude-sdk-external.cjs', import.meta.url)), executable);
    chmodSync(executable, 0o755);
    const runtime = await captureClaudeSdkRuntime(executable);
    assert.equal(runtime.path, executable);
    assert.equal(runtime.version, '2.1.312');
    const service = new ClaudeSdkAgentService({
      model: 'fixture',
      mcpServerPath: '',
      l0CompilerFn: async () => 'identity',
      runtimeResolver: () => runtime,
      queryFn: query,
    });
    const events = [];
    for await (const event of service.invoke('fixture', { toolExecutionPolicy: { mode: 'read_only' } }))
      events.push(event);
    assert.deepEqual(
      events.filter((event) => event.type === 'error'),
      [],
    );
    assert.ok(events.some((event) => event.content === 'external-runtime-used'));
    assert.equal(events.at(-1).type, 'done');
    const { probeRuntimeCatalog } = await import('../dist/routes/runtime-catalog-probe.js');
    const catalog = await probeRuntimeCatalog({ kind: 'claude', command: executable, args: [], cwd: root });
    assert.equal(catalog.status, 'live');
    assert.ok(catalog.models.some((model) => model.value === 'claude-fixture' || model.id === 'claude-fixture'));
  },
);

test('a missing runtime prevents the carrier from entering the SDK', async () => {
  let calls = 0;
  const service = new ClaudeSdkAgentService({
    model: 'fixture',
    mcpServerPath: '',
    l0CompilerFn: async () => 'identity',
    runtimeResolver: () => captureClaudeSdkRuntime(join(tmpdir(), 'not-installed-claude-1748')),
    queryFn: () => {
      calls++;
      throw new Error('must not reach SDK');
    },
  });
  const events = [];
  for await (const event of service.invoke('fixture')) events.push(event);
  assert.equal(calls, 0);
  assert.ok(events.some((event) => event.type === 'error' && event.error.includes('claude_runtime_missing')));
});

test('a slow version probe yields to the Host event loop and can be cancelled', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-version-async-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const path = join(root, 'slow-cli.js');
  writeFileSync(path, 'setTimeout(() => console.log("2.1.312 (Claude Code)"), 250);');
  chmodSync(path, 0o755);
  let heartbeat = false;
  const timer = setTimeout(() => {
    heartbeat = true;
  }, 20);
  t.after(() => clearTimeout(timer));
  const captured = await captureClaudeSdkRuntime(path);
  assert.equal(heartbeat, true, 'other Host work must run while the external process starts');
  assert.equal(captured.version, '2.1.312');
  await assert.rejects(captureClaudeSdkRuntime(path, AbortSignal.timeout(20)), { name: 'AbortError' });
});
