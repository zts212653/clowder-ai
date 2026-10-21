import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callRealPartner, openLiveJourney, roleIdentity } from './native-team-live.harness.mjs';
import { assertLivePageHealthy } from './native-team-observers.mjs';

// Preserve the failed first observer run. This continuation neither resets the
// installation nor pretends that its original uninterrupted journey passed.
test('continue the original completed demo into five real partners', { timeout: 1200000 }, async () => {
  assert.equal(process.env.CAT_CAFE_ONBOARDING_LIVE_MODE, 'continue-demo');
  const journey = await openLiveJourney();
  const { page, request, record } = journey;
  const creates = [];
  const capabilities = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/cats') creates.push(req.postDataJSON());
    if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/capabilities') capabilities.push(req.url());
  });
  try {
    assert.equal((await request('/api/cats')).cats.length, 0);
    assert.equal((await request('/api/messages?threadId=default&limit=50')).messages.length, 0);
    await page.getByRole('link', { name: '创建我的猫猫 →', exact: true }).click();
    const setup = page.getByTestId('recommended-team-setup');
    await setup.waitFor();
    for (const label of ['Codex', 'Claude Code', 'DSH', 'Kimi', 'Pi']) {
      const choice = page.getByRole('checkbox', { name: `加入 ${label} 伙伴`, exact: true });
      assert.ok(await choice.isEnabled());
      assert.ok(await choice.isChecked());
    }
    await journey.screenshot('five-detected-clients');
    await page.getByRole('button', { name: '一键创建 5 位伙伴', exact: true }).click();
    await setup.waitFor({ state: 'hidden', timeout: 60000 });
    const cats = (await request('/api/cats')).cats;
    assert.equal(cats.length, 5);
    assert.equal(creates.length, 5);
    assert.deepEqual(capabilities, []);
    record.roles = cats.map(roleIdentity);
    await journey.log('original-demo-continued-into-five-real-roles');
    for (const id of ['codex', 'claude-code', 'dsh', 'kimi', 'pi']) {
      const cat = cats.find((row) => row.id === id);
      assert.ok(cat?.avatar && cat.avatar !== '/avatars/default.png');
      await callRealPartner(journey, cat);
    }
    assertLivePageHealthy(record);
    assert.ok(record.calls.length === 5 && record.calls.every((call) => call.passed), 'All actual tasks must pass');
  } catch (error) {
    record.failure = String(error.message).slice(0, 800);
    await journey.screenshot('continuation-failure').catch(() => {});
    throw error;
  } finally {
    await journey.close();
  }
});
