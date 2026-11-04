import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { persistStartupRecovery } from '../src/domains/cats/services/agents/routing/startup-recovery-projection.js';
import { safeParseExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.js';
import { createCodexStartupRouteHarness } from './helpers/codex-startup-route-harness.mjs';

for (const mode of ['serial', 'parallel'])
  for (const origin of ['user', 'system_wake']) {
    test(`F320: ${mode} ${origin} writes recovery before broadcast and reads it back on the original response`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'startup-route-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const writes = [];
      const h = createCodexStartupRouteHarness({
        root,
        onEvent: async (event, run, store) => {
          if (event.extra?.startupRecovery) {
            const response = await store.getById(run.responseId);
            assert.deepEqual(response.extra.startupRecovery, event.extra.startupRecovery);
            assert.equal(event.messageId, response.id);
            writes.push(event.extra.startupRecovery.stage);
          }
        },
      });
      const run = h.start({ mode, origin });
      const result = await run.pending;
      assert.equal(result.lifecycle.status, 'completed', JSON.stringify(run.events.filter((e) => e.type === 'error')));
      assert.equal(run.wires.length, 3);
      assert.equal(run.wires.flatMap((w) => w.writes).filter((m) => m.method === 'turn/start').length, 1);
      assert.equal(result.extra.startupRecovery.stage, 'ready');
      assert.equal(result.extra.startupRecovery.attempt, 3);
      assert.ok(writes.includes('retry_wait'));
      assert.equal(safeParseExtra(JSON.stringify(result.extra)).startupRecovery.stage, 'ready');
      assert.ok((await h.store.getByThread('startup-chat')).some((m) => m.id === result.id));
      assert.equal(
        run.launchSnapshots.every(
          (s) => s.executionAccount?.accountRef === run.launchSnapshots[0].executionAccount?.accountRef,
        ),
        true,
      );
    });
  }

for (const mode of ['serial', 'parallel'])
  test(`F320: ${mode} final failure retains one original response and same-request diagnostics`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'startup-failed-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const h = createCodexStartupRouteHarness({ root });
    const run = h.start({ mode, origin: 'system_wake', scenario: 'fail' });
    const result = await run.pending;
    assert.equal(result.lifecycle.status, 'failed');
    assert.equal(result.extra.startupRecovery.stage, 'failed');
    assert.equal(result.extra.startupRecovery.attempt, 6);
    assert.equal(result.metadata.cliDiagnostics.accountCheck.rpcCode, -32603);
    assert.equal(result.metadata.cliDiagnostics.accountCheck.category, 'discovery_timeout');
    assert.equal(result.metadata.cliDiagnostics.safeExcerpt, 'workspace routing discovery timed out');
    assert.match(result.content, /本次任务尚未开始/);
    assert.equal((await h.store.getByThread('startup-chat')).filter((m) => m.lifecycle?.kind === 'response').length, 1);
    assert.equal(
      run.wires.some((w) => w.writes.some((m) => m.method === 'turn/start')),
      false,
    );
    const stale = { ...result.extra.startupRecovery, sequence: 100, stage: 'retry_wait' };
    assert.equal(
      await persistStartupRecovery(
        h.store,
        { type: 'system_info', catId: 'codex', timestamp: Date.now(), extra: { startupRecovery: stale } },
        result.id,
        result.lifecycle.invocationId,
      ),
      false,
    );
    assert.equal(h.store.getById(result.id).extra.startupRecovery.stage, 'failed');
  });

for (const mode of ['serial', 'parallel'])
  test(`F320: ${mode} cancellation commits a terminal startup projection even when route abort drops buffered events`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'startup-cancel-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const h = createCodexStartupRouteHarness({
      root,
      onEvent: (event, run) => {
        if (event.extra?.startupRecovery?.stage === 'retry_wait') run.controller.abort('user_cancel');
      },
    });
    const run = h.start({ mode, scenario: 'fail' });
    const result = await run.pending;
    assert.equal(result.lifecycle.status, 'canceled');
    assert.equal(result.extra.startupRecovery.stage, 'cancelled');
    assert.equal(run.wires.length, 1);
  });
