import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exerciseDemoPreview } from './native-demo-preview.mjs';
import { openLiveJourney } from './native-team-live.harness.mjs';
import { assertLivePageHealthy } from './native-team-observers.mjs';

test('recheck the original completed native result without replay or reload', { timeout: 30000 }, async () => {
  const journey = await openLiveJourney();
  try {
    assert.ok(journey.nativeRenderer);
    const observer = await exerciseDemoPreview(journey, '原始成果复核任务');
    await journey.screenshot('original-preview-interaction');
    await journey.log('original-native-preview-interactive', { observer, restartedOrReplayed: false });
    assertLivePageHealthy(journey.record);
  } finally {
    await journey.close();
  }
});
