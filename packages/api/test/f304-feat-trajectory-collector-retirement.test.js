import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const INDEX_PATH = new URL('../src/index.ts', import.meta.url);
const TASK_SPEC_PATH = new URL('../src/domains/feat-trajectory/FeatTrajectoryCollectorTaskSpec.ts', import.meta.url);

describe('F304 feat-trajectory collector retirement', () => {
  test('production bootstrap cannot register the retired collector', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');

    assert.doesNotMatch(source, /createFeatTrajectoryCollectorTaskSpec/);
    assert.doesNotMatch(source, /F233_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS/);
    assert.equal(existsSync(TASK_SPEC_PATH), false, 'retired cron TaskSpec must not remain as a callable factory');
  });

  test('historical trajectory read route remains registered', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');

    assert.match(source, /featTrajectoryRoutes/);
    assert.match(source, /featTrajectoryStore/);
  });
});
