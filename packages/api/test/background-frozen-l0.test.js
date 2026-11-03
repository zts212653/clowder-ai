import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { compileL0ViaSubprocess } from '../dist/domains/cats/services/agents/providers/l0-compiler.js';
import { captureInvocationL0Input } from '../dist/domains/cats/services/agents/providers/l0-input-capture.js';
import { extractTasks } from '../dist/domains/cats/services/orchestration/TaskExtractor.js';
import { runLunaNative } from '../dist/domains/memory/curation/LunaNativeRun.js';
import { resolveCurationProvider } from '../dist/domains/memory/curation-provider.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
function isolate(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-l0-regression-'));
  const keys = [
    'HOME',
    'USERPROFILE',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CAT_CAFE_DATA_DIR',
    'CAT_TEMPLATE_PATH',
    'CAT_CAFE_CONFIG_ROOT',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CLAUDE_CONFIG_DIR',
  ];
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  const cwd = process.cwd();
  keys.forEach((key) => {
    process.env[key] = root;
  });
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  copyFileSync(join(repoRoot, 'cat-template.json'), join(root, 'cat-template.json'));
  t.after(() => {
    process.chdir(cwd);
    old.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    console.log('retained reviewer fixture', root);
  });
  return root;
}
for (const operation of ['curation', 'task-extraction'])
  test(`the actual ${operation} owner reaches the native carrier with frozen L0`, async (t) => {
    const root = isolate(t);
    const all = catRegistry.getAllConfigs();
    const id = 'review-l0-curator';
    catRegistry.register(id, {
      ...all.codex,
      id,
      configurationSource: 'native_tool',
      accountRef: undefined,
      relationshipKey: 'review-l0',
      defaultModel: 'fixture-model',
    });
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const provider = resolveCurationProvider(root, id);
    provider.service.cliCommand = process.execPath;
    let spawned = 0;
    const errors = [];
    provider.service.spawnFn = () => {
      spawned++;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 12345;
      child.exitCode = null;
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.end(
          [
            { type: 'thread.started', thread_id: 'review-l0-native' },
            {
              type: 'item.completed',
              item: {
                id: 'm1',
                type: 'agent_message',
                text:
                  operation === 'curation'
                    ? 'isolated summary'
                    : '[{"title":"Captured task","why":"Native extraction","sourceIndex":0}]',
              },
            },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n') + '\n',
        );
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    };
    const invoke = provider.service.invoke.bind(provider.service);
    provider.service.invoke = async function* (prompt, options) {
      for await (const message of invoke(prompt, options)) {
        if (message.type === 'error') errors.push(message.error);
        yield message;
      }
    };
    if (operation === 'curation') {
      const result = await runLunaNative({
        userId: 'native-task-owner',
        provider,
        prompt: 'isolated summary fixture',
        instructions: 'summarize',
        workingDirectory: root,
      });
      assert.equal(result.success, true, JSON.stringify({ result, spawned, errors }));
    } else {
      const result = await extractTasks(
        [{ id: 'source-1', content: 'Extract this task', catId: null }],
        provider.service,
        { catId: id, userId: 'native-task-owner', threadId: 'extraction-thread' },
      );
      assert.equal(result.degraded, false, JSON.stringify({ result, spawned, errors }));
      assert.equal(result.tasks[0].title, 'Captured task');
    }
    assert.equal(spawned, 1);
  });
test('freezing an external task retains the existing Host workflow overlay source', async (t) => {
  const root = isolate(t);
  const project = join(root, 'work');
  mkdirSync(join(root, '.cat-cafe', 'prompt-overlays'), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  const member = catRegistry.getOrThrow('codex').config;
  writeFileSync(
    join(root, '.cat-cafe', 'prompt-overlays', 'workflow-triggers.local.yaml'),
    JSON.stringify({ [member.breedId ?? 'codex']: 'HOST_PRIVATE_WORKFLOW_CANARY' }),
  );
  process.chdir(root);
  const diagnostic = await compileL0ViaSubprocess({
    catId: 'codex',
    userId: 'isolated-owner',
    cwd: root,
    dataDir: root,
  });
  const snapshot = captureInvocationL0Input({
    catId: 'codex',
    catConfig: member,
    userId: 'isolated-owner',
    profileRepository: { profileDir: () => root },
  });
  const frozen = await compileL0ViaSubprocess({
    catId: 'codex',
    userId: 'isolated-owner',
    cwd: project,
    frozenInput: snapshot,
    requireFrozenInput: true,
  });
  assert.ok(diagnostic.includes('HOST_PRIVATE_WORKFLOW_CANARY'));
  assert.ok(
    frozen.includes('HOST_PRIVATE_WORKFLOW_CANARY'),
    'Frozen invocation lost the existing Host workflow overlay',
  );
});

test('public native capture renders without consulting owner catalog, profile or workflow data', async (t) => {
  const root = isolate(t);
  process.env.CAT_TEMPLATE_PATH = join(root, 'absent-owner-catalog.json');
  const snapshot = captureInvocationL0Input({
    catId: 'public-native-consumer',
    projection: 'public',
    profileRepository: { profileDir: () => assert.fail('public capture read an owner profile') },
  });
  assert.deepEqual(Object.keys(snapshot.variables), ['PUBLIC_IDENTITY_BLOCK']);
  const body = await compileL0ViaSubprocess({
    catId: 'public-native-consumer',
    projection: 'public',
    frozenInput: snapshot,
    requireFrozenInput: true,
  });
  assert.match(body, /@public-native-consumer/);
  assert.doesNotMatch(body, /HOST_PRIVATE_WORKFLOW_CANARY|主人画像|队友名册/);
});
