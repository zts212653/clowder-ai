/**
 * F233 PR3 — production route wiring guards.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('F233 PR3: production route wiring', () => {
  test('messagesRoutes receives ballCustody ingest for zombie reconciliation events', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const messagesOpts = {');
    const end = source.indexOf('await app.register(messagesRoutes, messagesOpts);', start);

    assert.notEqual(start, -1, 'index.ts must define messagesOpts');
    assert.notEqual(end, -1, 'index.ts must register messagesRoutes with messagesOpts');

    const messagesOptsBlock = source.slice(start, end);
    assert.match(
      messagesOptsBlock,
      /ballCustodyIngest[\s\S]{0,120}\{\s*ballCustody:\s*ballCustodyIngest\s*\}/,
      'messagesOpts must pass ballCustodyIngest into messagesRoutes',
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
