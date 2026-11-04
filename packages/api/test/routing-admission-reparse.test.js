import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { configStore } from '../dist/config/ConfigStore.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import {
  buildFakeL0Compiler,
  createMockArchive,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

for (const [strategy, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  for (const change of [
    'once',
    'continuous',
    'replacement',
    'removed',
    'opaque-error',
    'cancel',
    'thread-workspace',
    'thread-effort',
  ]) {
    test(`${strategy} admission reparses ${change} without resending a model turn`, async (t) => {
      t.after(isolateAccountAuthEnvironment());
      const parent = resolve('artifacts/role-agent-refactor/admission-reparse');
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(join(parent, 'fixture-'));
      mkdirSync(join(root, '.cat-cafe'));
      copyFileSync(process.env.CAT_TEMPLATE_PATH, join(root, 'cat-template.json'));
      writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
      const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CODEX_SANDBOX_MODE', 'CAT_CAFE_PROJECT_ALLOWED_ROOTS'];
      const previous = new Map(keys.map((key) => [key, process.env[key]]));
      process.env.CAT_CAFE_CONFIG_ROOT = root;
      process.env.CAT_CODEX_SANDBOX_MODE = 'read-only';
      process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
      const all = catRegistry.getAllConfigs(),
        catId = 'admission-reparse';
      catRegistry.register(catId, {
        ...all.codex,
        id: catId,
        mcpSupport: false,
        configurationSource: 'native_tool',
        accountRef: undefined,
      });
      t.after(() => {
        configStore.reset();
        previous.forEach((value, key) => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        });
        catRegistry.reset();
        Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
      });
      const controller = new AbortController();
      let captures = 0;
      const launches = [];
      let deps;
      let threadId = 'reparse-thread';
      const threadChange = change.startsWith('thread-');
      const before = join(root, 'before'),
        after = join(root, 'after');
      const createService = (label) => {
        const service = new CodexAgentService({
          catId,
          model: 'fixture-model',
          cliCommand: process.execPath,
          l0CompilerFn: buildFakeL0Compiler(),
          rawArchive: createMockArchive(),
          spawnFn: (_command, args, options) => {
            launches.push({ label, args, cwd: options.cwd });
            const proc = createMockProcess();
            delete proc.pid;
            setImmediate(
              () =>
                void emitEvents(proc, [
                  { type: 'thread.started', thread_id: 'owned-reparse-session' },
                  { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: `owned-${label}-reply` } },
                  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
                ]),
            );
            return proc;
          },
        });
        const capture = service.captureInvocationOptions.bind(service);
        service.captureInvocationOptions = async (input) => {
          captures++;
          if (change === 'opaque-error') throw Object.assign(new Error('owned unknown discovery'), { statusCode: 409 });
          if (!threadChange && (change === 'continuous' || captures === 1))
            configStore.set(
              'cli.codexSandboxMode',
              process.env.CAT_CODEX_SANDBOX_MODE === 'read-only' ? 'workspace-write' : 'read-only',
            );
          if (threadChange && captures === 1) {
            const store = deps.invocationDeps.threadStore;
            if (change === 'thread-workspace') store.updateProjectPath(threadId, after);
            else store.updateMemberEffort(threadId, catId, 'high');
          }
          if (change === 'replacement' && captures === 1) deps.services[catId] = createService('new');
          if (change === 'removed' && captures === 1) {
            delete deps.services[catId];
            deps.unavailableServices.set(catId, {
              code: 'rejected-account-binding',
              message: 'owned updated unavailability',
            });
          }
          if (change === 'cancel') controller.abort();
          return capture(input);
        };
        return service;
      };
      const service = createService('old');
      ({ deps } = routingJourneyDeps(undefined, undefined, service));
      deps.services = { [catId]: service };
      deps.unavailableServices = new Map();
      deps.invocationDeps.contextEpochOwner = new ContextEpochOwner(new InMemoryContextEpochStore());
      if (threadChange) {
        mkdirSync(before);
        mkdirSync(after);
        const store = new ThreadStore();
        threadId = store.create('owner', 'Owned reparse journey').id;
        store.updateProjectPath(threadId, before);
        store.updateMemberEffort(threadId, catId, 'low');
        store.updateMemberSpeed(threadId, catId, 'standard');
        deps.invocationDeps.threadStore = store;
      }
      const messages = await Array.fromAsync(
        route(deps, [catId], 'isolated admission task', 'owner', threadId, {
          thinkingMode: 'play',
          signal: controller.signal,
        }),
      );
      assert.equal(captures, threadChange || ['once', 'continuous', 'replacement'].includes(change) ? 2 : 1);
      const success = threadChange || ['once', 'replacement'].includes(change);
      assert.equal(launches.length, success ? 1 : 0);
      if (success) {
        const label = change === 'replacement' ? 'new' : 'old';
        assert.deepEqual(
          messages.filter((message) => message.type === 'error'),
          [],
        );
        assert.ok(messages.some((message) => message.type === 'text' && message.content === `owned-${label}-reply`));
        assert.equal(launches[0].label, label);
        assert.equal(
          launches[0].args[launches[0].args.indexOf('--sandbox') + 1],
          threadChange ? 'read-only' : 'workspace-write',
        );
        if (change === 'thread-workspace') assert.equal(launches[0].cwd, after);
        if (change === 'thread-effort') assert.ok(launches[0].args.includes('model_reasoning_effort="high"'));
      } else if (change !== 'cancel') assert.ok(messages.some((message) => message.type === 'error'));
      if (change === 'continuous')
        assert.ok(messages.some((message) => message.errorCode === 'execution_binding_conflict'));
      if (change === 'opaque-error')
        assert.ok(messages.some((message) => message.errorCode === 'execution_binding_unavailable'));
      if (change === 'removed')
        assert.ok(
          messages.some(
            (message) => message.type === 'error' && message.error.includes('owned updated unavailability'),
          ),
        );
    });
  }
}
