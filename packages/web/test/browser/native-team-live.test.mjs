import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { callRealPartner, openLiveJourney, roleIdentity, verifyRetainedHistory } from './native-team-live.harness.mjs';
import { completeFirstRun } from './native-team-live-fresh.mjs';
import { assertLivePageHealthy, verifyVisibleRoute } from './native-team-observers.mjs';

test(
  'installed application: zero-role onboarding or retained-history verification, then real client tasks',
  { timeout: 1200000 },
  async () => {
    const mode = process.env.CAT_CAFE_ONBOARDING_LIVE_MODE;
    assert.ok(['fresh', 'verify'].includes(mode), 'Choose fresh or verify explicitly; never erase a roster');
    const journey = await openLiveJourney();
    const { page, record, web, log } = journey;
    try {
      let cats;
      if (mode === 'fresh') {
        cats = await completeFirstRun(journey);
      } else {
        const previousFile = process.env.CAT_CAFE_ONBOARDING_LIVE_PREVIOUS;
        assert.ok(previousFile, 'Supply the pre-restart live-journey.json; do not reset data');
        const previous = JSON.parse(await fs.readFile(previousFile, 'utf8'));
        cats = await verifyRetainedHistory(journey, previous);
      }
      record.roles = cats.map(roleIdentity);
      const ids = ['codex', 'claude-code', 'dsh', 'kimi', 'pi'];
      assert.deepEqual(cats.map((cat) => cat.id).sort(), [...ids].sort());
      for (const id of ids)
        await callRealPartner(
          journey,
          cats.find((cat) => cat.id === id),
        );
      await page.goto(new URL('/settings?s=members&view=setup&shell=v2&lang=zh', web).href);
      await page.waitForURL(
        (url) =>
          url.pathname === '/settings' &&
          url.searchParams.get('s') === 'members' &&
          url.searchParams.get('view') !== 'setup',
      );
      await verifyVisibleRoute(page, record, 'member-list-page');
      assert.equal(await page.getByTestId('recommended-team-setup').count(), 0);
      await log('existing-roster-does-not-recommend-initial-setup');
      assertLivePageHealthy(record);
      assert.ok(
        record.calls.length === 5 && record.calls.every((call) => call.passed),
        'All five clients must execute the unique real task, not merely return a greeting',
      );
      await log('all-live-acceptance-checks-passed');
    } catch (error) {
      record.failure = String(error.message).slice(0, 800);
      await journey.screenshot('journey-failure').catch(() => {});
      throw error;
    } finally {
      await journey.close();
    }
  },
);
