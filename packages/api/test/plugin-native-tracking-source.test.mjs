import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/task/plugin-task-host.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';
import { loadTrackingPackage } from './helpers/github-tracking-package.js';

async function fixture(t, pkg, privateSubscription = false) {
  const taskStore = new TaskStore();
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const registry = new InvocationRegistry();
  const userId = 'owner',
    catId = 'opus',
    instanceId = 'github-instance';
  const thread = threadStore.create(userId, 'Native tracking source fence');
  const origin = messageStore.append({
    from: { kind: 'user', userId },
    userId,
    threadId: thread.id,
    content: 'Track the review',
    mentions: [],
    timestamp: Date.now(),
  });
  const auth = await registry.create(userId, catId, thread.id, undefined, undefined, undefined, origin.id, 'strict');
  // Deliberately expose a live array: production must detach it before the first await.
  const inputs = [origin.id];
  let onRead = async () => {},
    onProvider = async () => {};
  const tasks = createPluginTaskHost({
    pluginId: pkg.manifest.pluginId,
    pluginInstanceId: instanceId,
    taskStore,
    threadStore,
    readThreadStore: threadStore,
    ownerUserId: userId,
  });
  const rows = new Map();
  let revision = 0;
  const storage = {
    get: async (key) => structuredClone(rows.get(key)),
    list: async () => structuredClone(Object.fromEntries(rows)),
    set: async (key, value) => {
      rows.set(key, { revision: ++revision, value: structuredClone(value) });
      return { revision };
    },
    compareAndSet: async (key, expected, value) => {
      if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
      rows.set(key, { revision: ++revision, value: structuredClone(value) });
      return { applied: true, revision };
    },
    delete: async (key) => ({ deleted: rows.delete(key) }),
  };
  const unexpected = async () => {
    throw new Error('Unexpected external effect');
  };
  const module = pkg.createGitHubPluginModule({
    createProvider: () => ({
      selfLogin: () => 'owner',
      read: async () => {
        await onProvider();
        return {
          state: 'open',
          headSha: 'a'.repeat(40),
          ci: 'pending',
          comments: [],
          reviews: [],
          commentsComplete: true,
          trackingIdentity: { selfLogin: 'owner', subjectAuthorLogin: 'owner' },
        };
      },
    }),
  });
  const active = await module.create(pkg.manifest).start({
    pluginInstanceId: instanceId,
    dataPath: pkg.root,
    storage,
    tasks,
    config: { get: async () => undefined },
    secrets: { get: async () => undefined },
    members: { list: async () => [], get: async () => null },
    threads: { get: async () => ({ ...thread, deepLinkUrl: 'https://host.invalid/thread' }) },
    streams: { read: unexpected },
    messaging: { send: unexpected },
    log: () => {},
  });
  t.after(() => active.stop({ reason: 'test complete' }));
  const admission = {
    instance: {
      pluginInstanceId: instanceId,
      packageDigest: privateSubscription ? '004171d8' : 'fee6fbfa',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: { manifest: pkg.manifest },
  };
  const carrier = createModuleHostInvocation({ runtime: { actions: () => active.actions } });
  const actions = new NativePluginActions(async () => admission);
  actions.activate(admission, 0, (method, input) => carrier.invoke(instanceId, method, input));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(pluginNativeActionRoutes, {
    actions,
    registry,
    threadStore,
    sources: {
      messageStore: {
        getById: async (id) => {
          await onRead(id);
          return messageStore.getById(id);
        },
      },
      invocationTracker: {
        getActiveSlots: () => [
          {
            catId,
            activeRun: {
              invocationId: auth.invocationId,
              threadId: thread.id,
              targetId: catId,
              inputMessageIds: inputs,
            },
          },
        ],
      },
    },
  });
  const identity = { taskStore, invocationId: auth.invocationId, userId, catId, threadId: thread.id };
  return {
    origin,
    inputs,
    identity,
    taskStore,
    onRead(fn) {
      onRead = fn;
    },
    onProvider(fn) {
      onProvider = fn;
    },
    adopt(suffix, scope = {}) {
      const holdTaskId = `hold-${suffix}`;
      const source = messageStore.append({
        from: { kind: 'system', service: 'hold-ball' },
        userId: scope.userId ?? userId,
        threadId: scope.threadId ?? thread.id,
        content: 'Command complete',
        mentions: [],
        timestamp: Date.now(),
        source: {
          connector: 'hold-ball',
          label: 'command',
          icon: 'hold-ball',
          meta: {
            managedHold: true,
            wakeWhen: true,
            phase: 'wake',
            taskId: holdTaskId,
            threadId: scope.threadId ?? thread.id,
            catId: scope.catId ?? catId,
          },
        },
      });
      inputs.push(source.id);
      return { sourceMessageId: source.id, holdTaskId };
    },
    async register(kind) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/plugin-runtime/action',
        headers: {
          'x-invocation-id': auth.invocationId,
          'x-callback-token': auth.callbackToken,
          'x-clowder-plugin-action-token': actions.environment(instanceId, 'github-tracking')
            .CLOWDER_PLUGIN_ACTION_TOKEN,
        },
        payload: {
          method: `github.typed-wait.register-${kind}`,
          input: {
            registrationId: `registration-${kind}`,
            repoFullName: 'owner/repo',
            ...(kind === 'pr'
              ? { prNumber: 1, when: [{ kind: 'pr_ci_terminal' }] }
              : { issueNumber: 1, when: [{ kind: 'issue_comment_added', authorLogins: ['reviewer'] }] }),
          },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().result;
      assert.ok(result.automationState.await, 'real package registered a public wait');
      const task = await taskStore.get(result.id);
      if (privateSubscription) {
        assert.equal(task, null, 'a fresh private subscription must not manufacture a Host Task');
        assert.ok(
          JSON.stringify([...rows.values()]).includes(result.id),
          'the actual package persisted its subscription',
        );
        assert.equal(result.userId, userId);
        assert.equal(result.ownerCatId, catId);
        assert.equal(result.threadId, thread.id);
        return result;
      }
      assert.ok(task.pluginWait.await, 'real Host task port persisted the active wait');
      assert.equal(task.pluginWait.pluginInstanceId, instanceId);
      return task;
    },
    resolve: (source) => resolveTypedWaitContinuation({ ...identity, ...source }),
  };
}

const currentGeneration = process.env.F202_TRACKING_GENERATION === 'current';

test(
  currentGeneration
    ? 'current GitHub artifact persists fresh private subscriptions through the real Host native route'
    : 'actual GitHub package native tracking source binding',
  async (t) => {
    const pkg = await loadTrackingPackage(t, currentGeneration ? 'current' : 'c1');
    if (currentGeneration) {
      for (const kind of ['pr', 'issue']) {
        const f = await fixture(t, pkg, true);
        f.adopt('completed-command');
        const first = await f.register(kind);
        const replay = await f.register(kind);
        assert.equal(replay.id, first.id);
        assert.deepEqual(replay.automationState.await, first.automationState.await);
        assert.equal(first.automationState.await.generation, 1);
      }
      return;
    }
    for (const kind of ['pr', 'issue']) {
      await t.test(`${kind}: one adopted input binds only its exact source/hold`, async (t) => {
        const f = await fixture(t, pkg);
        const adopted = f.adopt('one');
        const task = await f.register(kind);
        assert.deepEqual(task.pluginWait.registration.source, { kind: 'adopted_hold', ...adopted });
        assert.equal(task.pluginWait.registration.invocationId, f.identity.invocationId);
        assert.equal((await f.resolve(adopted)).kind, 'bypass');
        for (const source of [
          { ...adopted, holdTaskId: 'wrong' },
          { ...adopted, sourceMessageId: f.origin.id },
          { ...adopted, invocationId: 'other-invocation' },
        ])
          assert.equal((await f.resolve(source)).kind, 'reject');
      });
      for (const reversed of [false, true]) {
        await t.test(
          `${kind}: ambiguous inputs (${reversed ? 'reversed' : 'normal'}) grant neither hold`,
          async (t) => {
            const f = await fixture(t, pkg);
            const first = f.adopt('one'),
              second = f.adopt('two');
            if (reversed) f.inputs.reverse();
            const task = await f.register(kind);
            assert.equal(task.pluginWait.registration, undefined);
            for (const source of [first, second]) assert.equal((await f.resolve(source)).kind, 'reject');
          },
        );
      }
      await t.test(`${kind}: a foreign-thread input poisons otherwise eligible authority`, async (t) => {
        const f = await fixture(t, pkg);
        const eligible = f.adopt('one'),
          foreign = f.adopt('foreign', { threadId: 'another-thread' });
        const task = await f.register(kind);
        assert.equal(task.pluginWait.registration, undefined);
        for (const source of [eligible, foreign]) assert.equal((await f.resolve(source)).kind, 'reject');
      });
      await t.test(`${kind}: a different member's hold cannot acquire continuation authority`, async (t) => {
        const f = await fixture(t, pkg);
        const foreign = f.adopt('foreign-cat', { catId: 'codex' });
        const task = await f.register(kind);
        assert.deepEqual(task.pluginWait.registration.source, { kind: 'primary', sourceMessageId: f.origin.id });
        assert.equal((await f.resolve(foreign)).kind, 'reject');
      });
      await t.test(`${kind}: adoption while source reads await cannot enter the captured input set`, async (t) => {
        const f = await fixture(t, pkg);
        let late;
        f.onRead(async () => {
          if (!late) late = f.adopt('late-read');
        });
        const task = await f.register(kind);
        assert.deepEqual(task.pluginWait.registration.source, { kind: 'primary', sourceMessageId: f.origin.id });
        assert.equal((await f.resolve(late)).kind, 'reject');
      });
      await t.test(`${kind}: adoption after capture and registration replay preserve the stored receipt`, async (t) => {
        const f = await fixture(t, pkg);
        const first = f.adopt('one');
        let late;
        f.onProvider(async () => {
          late = f.adopt('after-capture');
        });
        const task = await f.register(kind);
        const receipt = structuredClone(task.pluginWait.registration);
        assert.deepEqual(receipt.source, { kind: 'adopted_hold', ...first });
        assert.equal((await f.resolve(late)).kind, 'reject');
        const replay = await f.register(kind);
        assert.equal(replay.pluginWait.generation, task.pluginWait.generation);
        assert.deepEqual(replay.pluginWait.registration, receipt);
        assert.equal((await f.resolve(first)).kind, 'bypass');
        assert.equal((await f.resolve(late)).kind, 'reject');
      });
    }
  },
);
