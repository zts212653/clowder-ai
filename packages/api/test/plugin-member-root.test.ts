import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { NativePluginActions } from '../src/domains/plugin/declared/native-plugin-actions.js';
import { pluginSentMessageStorageKey } from '../src/domains/plugin/host-surface/plugin-sent-message-read.js';
import { createRootMemberSessions } from '../src/domains/plugin/member-sessions/root.js';
import { memberExecutionKey } from '../src/domains/plugin/member-sessions/validation.js';
import type { DormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { migrateStoredProjectPath } from '../src/utils/persistent-project-path.js';
import { FakeStorageRedis } from './helpers/fake-plugin-storage-redis.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

test('production Root creates a protected thread using canonical profiles and existing account metadata, without models or login copies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'member-root-'));
  const workspace = await mkdtemp(join(tmpdir(), 'member-persistent-'));
  const oldRuntime = process.env.CAT_CAFE_RUNTIME_ROOT,
    oldWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT;
  process.env.CAT_CAFE_RUNTIME_ROOT = root;
  process.env.CAT_CAFE_WORKSPACE_ROOT = workspace;
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
    if (oldRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = oldRuntime;
    if (oldWorkspace === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = oldWorkspace;
    await rm(workspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const accounts = join(root, '.cat-cafe', 'accounts.json');
  await mkdir(dirname(accounts), { recursive: true });
  await writeFile(accounts, JSON.stringify({ subscription: { clientId: 'openai', authType: 'oauth' } }));
  const before = await readFile(accounts, 'utf8');
  const profiles = new FileProfileRepository({
    dataDir: join(root, 'profiles'),
    relationshipKeyForCat: () => 'maine-coon',
  });
  const corpus = profiles.corpusPath('owner');
  await mkdir(dirname(corpus), { recursive: true });
  await writeFile(corpus, 'APPROVED_OWNER_HISTORY');
  const redis = new FakeStorageRedis(),
    threads = new ThreadStore(),
    messages = new MessageStore(),
    turns = new InMemoryTurnExecutionStore(),
    agents = new AgentRegistry();
  let modelStarts = 0;
  agents.register('codex', {
    async *invoke() {
      modelStarts++;
      throw new Error('no model authorized by this check');
    },
  });
  const pkg = {
    packageDigest: 'package-v1',
    packageState: 'installed',
    manifest: { contributions: [{ type: 'mcp', id: 'player-tools' }] },
  };
  const runtime = {
    inventoryStore: {
      readAuthority: async (pluginInstanceId: string) => {
        assert.equal(pluginInstanceId, 'installed');
        return {
          instance: {
            pluginInstanceId,
            pluginId: 'fixture.member',
            packageDigest: pkg.packageDigest,
            lifecycleState: 'installed',
            activationState: 'enabled',
            configReadiness: 'ready',
          },
          packageRecord: pkg,
        };
      },
    },
    supervisor: {
      resolveNativeMcpLaunch: async () => ({
        name: 'game',
        command: '/usr/bin/true',
        args: [],
        env: {},
        workingDirectory: root,
        transport: 'stdio',
      }),
    },
  } as unknown as DormantPluginRuntimeComposition;
  const scope = {
    ownerUserId: 'owner',
    pluginInstanceId: 'installed',
    packageDigest: pkg.packageDigest,
    activationId: 'actual-root-activation',
    assertCurrent: async () => {},
  };
  let targetReads = 0;
  const compose = () =>
    createRootMemberSessions({
      redis: redis as unknown as RedisClient,
      ownerUserId: 'owner',
      projectRoot: root,
      agents,
      threads,
      messages,
      readMessageTargets: async () => {
        targetReads++;
        return ['codex'];
      },
      turns,
      profiles,
      pluginRuntime: () => runtime,
      invocationDeps: () => {
        throw new Error('no child starts during preparation');
      },
    });
  const host = compose();
  const refs = await host.profileReferences({ ...scope, catId: 'codex' });
  assert.equal(refs.length, 1);
  const input = {
    title: 'Own game',
    catId: 'codex',
    contributionId: 'player-tools',
    identity: 'player',
    memory: refs,
    accountSelection: { accountRef: 'subscription', authType: 'oauth' as const },
  };
  const f = memberSessionFixture();
  const resources = await f.owner(
    () => host.forInstance(scope).describe({ catId: 'codex' }),
    'owner-resource-read',
    false,
  );
  assert.equal(resources.available, true);
  const option = resources.accounts.find((account) => account.accountRef === 'subscription');
  assert.ok(option?.available && option.selection);
  assert.deepEqual(resources.memory, [{ ...refs[0], bytes: Buffer.byteLength('APPROVED_OWNER_HISTORY') }]);
  assert.equal(threads.list('owner').length, 0);
  assert.equal(modelStarts, 0);
  const operatorThread = threads.create('owner', 'Operator');
  const source = messages.append({
    threadId: operatorThread.id,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'Please prepare a cheap game round.',
    timestamp: Date.now(),
  });
  const authority = {
    instance: {
      pluginInstanceId: 'installed',
      packageDigest: 'package-v1',
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: pkg,
  };
  const native = new NativePluginActions(async () => authority as never);
  native.activate(authority as never, 0, () => host.forInstance(scope).describe({ catId: 'codex' }));
  const token = native.environment('installed', 'player-tools').CLOWDER_PLUGIN_ACTION_TOKEN;
  assert.ok(token);
  const delegated = await native.call(
    token,
    'manager.describe',
    {},
    {
      catId: 'operator',
      threadId: operatorThread.id,
      userId: 'owner',
      invocationId: 'actual-owner-invocation',
      originTriggerMessageId: source.id,
      ownerAuthProvenance: 'strict',
      assertCurrent: async () => {},
    },
  );
  assert.deepEqual(
    delegated,
    resources,
    'actual Native→Root uses the canonical owner message without HTTP confirmation',
  );
  native.deactivate('installed');
  assert.ok(!JSON.stringify(resources).includes('APPROVED_OWNER_HISTORY'));
  assert.ok(!JSON.stringify(resources).includes(root));
  const binding = await f.owner(
    () =>
      host.forInstance(scope).ensureThread({
        catId: input.catId,
        contributionId: input.contributionId,
        identity: input.identity,
        title: input.title,
        creationKey: 'persistent-seat',
      }),
    'owner-ensure-thread',
  );
  assert.equal(await host.forInstance(scope).get(binding.sessionId), null);
  const { title: _creationTitle, ...selection } = input;
  const session = await f.owner(
    () =>
      host.forInstance(scope).prepare({ ...selection, threadId: binding.threadId, accountSelection: option.selection }),
    'owner-prepare',
  );
  assert.equal(session.runtime.account.accountRef, 'subscription');
  assert.equal(session.runtime.carrier, 'codex_exec_json');
  assert.equal(session.activationId, scope.activationId);
  assert.equal(threads.get(session.threadId)?.createdBy, 'owner');
  assert.deepEqual(threads.get(session.threadId)?.participants, [createCatId('codex')]);
  assert.ok(threads.get(session.threadId)?.projectPath?.includes('member-workspaces'));
  const managedPath = threads.get(session.threadId)?.projectPath;
  assert.ok(managedPath);
  assert.equal(
    await migrateStoredProjectPath(managedPath),
    managedPath,
    'a thread GET must preserve the actual managed cwd',
  );
  await assert.rejects(
    access(join(workspace, relative(root, managedPath))),
    { code: 'ENOENT' },
    'prepare must not create a source-checkout twin',
  );
  await threads.updateProjectPath(session.threadId, 'default');
  const restored = await f.owner(
    () =>
      host.forInstance(scope).prepare({ ...selection, threadId: binding.threadId, accountSelection: option.selection }),
    'owner-prepare',
  );
  assert.equal(restored.sessionId, session.sessionId);
  assert.equal(restored.generation, session.generation);
  assert.equal(
    threads.get(session.threadId)?.projectPath,
    managedPath,
    'recover a previously migrated controlled thread in place',
  );
  const route = await compose().routing.resolve({
    userId: 'owner',
    threadId: session.threadId,
    sourceMessageId: 'foreign-source',
    targetCats: [createCatId('codex')],
    options: {},
  });
  assert.equal(route.kind, 'controlled');
  if (route.kind === 'controlled')
    await assert.rejects(async () => {
      for await (const _ of route.stream) {
      }
    }, /original_execution_unavailable/);
  const run = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'original-queued',
    semanticCursor: 1,
    content: 'Original visible game input',
  };
  const original = messages.append({
    threadId: session.threadId,
    userId: 'owner',
    from: { kind: 'plugin', instanceId: 'installed' },
    content: run.content,
    timestamp: Date.now(),
    deliveryStatus: 'queued',
    extra: {
      pluginMessage: {
        instanceId: 'installed',
        revision: 1,
        provenance: { epistemicStatus: 'observation' },
        elements: [],
      },
    },
    idempotencyKey: pluginSentMessageStorageKey('installed', memberExecutionKey(run)),
  });
  const accepted = await host.forInstance(scope).execute(run);
  assert.equal(accepted.messageId, original.id);
  assert.equal(accepted.phase, 'queued');
  const recovered = await compose().forInstance(scope).execute(run);
  assert.equal(recovered.messageId, original.id);
  assert.equal(recovered.phase, 'queued');
  assert.ok(targetReads > 0, 'production Root must query canonical Queue recipients, not invent a successful route');
  assert.equal(modelStarts, 0);
  await writeFile(corpus, 'CHANGED_OWNER_HISTORY');
  const { title: _title, ...prepared } = input;
  await assert.rejects(
    f.owner(
      () =>
        host
          .forInstance(scope)
          .prepare({ ...prepared, threadId: session.threadId, accountSelection: option.selection }),
      'owner-prepare',
    ),
    /memory_changed/,
  );
  assert.equal(await readFile(accounts, 'utf8'), before);
  assert.equal(modelStarts, 0);
  assert.ok(!JSON.stringify(session).includes('APPROVED_OWNER_HISTORY'));
});
