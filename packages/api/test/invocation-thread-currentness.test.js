import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

for (const change of ['workspace', 'effort', 'speed', 'other-member']) {
  test(`formal admission checks consumed thread inputs after a ${change} write`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/thread-currentness');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const before = join(root, 'before'),
      after = join(root, 'after');
    mkdirSync(before);
    mkdirSync(after);
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_PROJECT_ALLOWED_ROOTS'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    const all = catRegistry.getAllConfigs(),
      catId = 'thread-currentness';
    catRegistry.register(catId, {
      ...all.codex,
      id: catId,
      mcpSupport: false,
      accountRef: undefined,
      configurationSource: 'native_tool',
    });
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const threadStore = new ThreadStore();
    const thread = threadStore.create('owner', 'Owned admission fixture');
    threadStore.updateProjectPath(thread.id, before);
    threadStore.updateMemberEffort(thread.id, catId, 'low');
    threadStore.updateMemberSpeed(thread.id, catId, 'fast');
    let captures = 0;
    const service = {
      async captureInvocationOptions() {
        if (++captures !== 1) return {};
        if (change === 'workspace') threadStore.updateProjectPath(thread.id, after);
        else if (change === 'effort') threadStore.updateMemberEffort(thread.id, catId, 'high');
        else if (change === 'speed') threadStore.updateMemberSpeed(thread.id, catId, 'standard');
        else threadStore.updateMemberEffort(thread.id, 'other-member', 'high');
        return {};
      },
      async *invoke() {
        assert.fail('admission must not send a model turn');
      },
    };
    const capture = () =>
      prepareInvocationExecutionBinding(
        { threadStore, apiUrl: 'http://127.0.0.1:13004' },
        { catId, service, threadId: thread.id, userId: 'owner' },
      );
    if (change === 'other-member') {
      const binding = await capture();
      assert.equal(binding.threadPreferences.reasoningEffortOverride, 'low');
      assert.equal(binding.threadPreferences.speedOverride, 'fast');
      assert.equal(binding.workspace.workingDirectory, before);
      return;
    }
    await assert.rejects(capture(), ExecutionAdmissionConflict);
    const next = await capture();
    assert.equal(next.workspace.workingDirectory, change === 'workspace' ? after : before);
    assert.equal(next.threadPreferences.reasoningEffortOverride, change === 'effort' ? 'high' : 'low');
    assert.equal(next.threadPreferences.speedOverride, change === 'speed' ? 'standard' : 'fast');
    assert.equal(captures, 2);
  });
}
