/**
 * F233 PR3 — production route wiring guards.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('F233 PR3: production route wiring', () => {
  test('explicit owner reaper receives ballCustody ingest for zombie reconciliation events', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const invocationOwnerReaper = new InvocationOwnerReaper({');
    const end = source.indexOf('socketManager.setQueueProcessor(queueProcessor);', start);

    assert.notEqual(start, -1, 'index.ts must compose InvocationOwnerReaper');
    assert.notEqual(end, -1, 'index.ts must finish owner-reaper composition before queue registration');

    const reaperBlock = source.slice(start, end);
    assert.match(
      reaperBlock,
      /ballCustodyIngest[\s\S]{0,120}\{\s*ballCustody:\s*ballCustodyIngest\s*\}/,
      'InvocationOwnerReaper must pass ballCustodyIngest into explicit zombie reconciliation',
    );
  });

  test('PR4 registers ball-custody probe scheduler with projection store', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /let ballCustodyProjectionStore:/, 'index.ts must retain projection store for PR4 readers');
    assert.match(source, /new BallCustodyProbeScheduler\(\{[\s\S]*projectionStore:\s*ballCustodyProjectionStore/);
    assert.match(source, /taskRunnerV2\.register\(\s*createBallCustodyProbeTaskSpec/);
  });

  test('PR4 probe poller timeout covers accepted HTTP probe timeout', async () => {
    const { createBallCustodyProbeTaskSpec } = await import('../dist/domains/ball-custody/BallCustodyProbeTaskSpec.js');
    const task = createBallCustodyProbeTaskSpec({
      scheduler: {
        tick: async () => ({
          checked: 0,
          completed: 0,
          woken: 0,
          idleMarked: 0,
          cooldownSkipped: 0,
          skipped: 0,
          failed: 0,
        }),
      },
    });

    assert.ok(task.run.timeoutMs > 60_000, 'poller timeout must exceed any accepted HTTP probe timeout');
  });
});
