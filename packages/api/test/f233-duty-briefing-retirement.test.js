import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

// Startup registration is the contract: a restart must never revive daily cards.
// This follows the F304 collector retirement guard without booting the full API.
test('F233 retirement: bootstrap cannot register or expose a briefing producer', () => {
  assert.equal(
    /duty-briefing|dutyBriefing|briefingConfig|createDutyBriefingDailySpec/.test(source('index.ts')),
    false,
    'bootstrap must not register the retired daily cron or on-demand routes',
  );
  for (const path of [
    'routes/duty-briefing.ts',
    'domains/cats/services/duty-briefing/duty-briefing-cron-spec.ts',
    'domains/cats/services/duty-briefing/generateAndDeliverBriefing.ts',
  ]) {
    assert.equal(existsSync(new URL(`../src/${path}`, import.meta.url)), false, `${path} must be retired`);
  }
});

test('F233 retirement: task audit and Story historical readers stay wired', () => {
  assert.match(source('index.ts'), /withBallCustodyTaskEvents\(/);
  assert.match(source('index.ts'), /app\.register\(storyRenderingRoutes/);
  assert.match(source('routes/story-rendering.ts'), /opts\.featTrajectoryStore\.get\(featId\)/);
});
