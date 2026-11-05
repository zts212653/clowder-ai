import assert from 'node:assert/strict';
import { exerciseDemoPreview } from './native-demo-preview.mjs';
import { verifyVisibleRoute } from './native-team-observers.mjs';
export async function completeFirstRun(journey) {
  const { page, request, web, log } = journey;
  assert.equal((await request('/api/cats')).cats.length, 0);
  assert.equal((await request('/api/messages?threadId=default&limit=50')).messages.length, 0);
  const creates = [];
  const capabilitySettingsReads = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/cats') creates.push(req.postDataJSON());
    if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/capabilities')
      capabilitySettingsReads.push(req.url());
  });
  await log('zero-roles-and-messages-confirmed');
  if (journey.nativeRenderer) {
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'v2');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('cat-cafe:shell-presentation')),
      'v2',
      'A fresh installation must open the new shell itself',
    );
  } else {
    await page.goto(new URL('/?shell=v2&lang=zh', web).href);
  }
  const demo = page.getByRole('dialog').filter({ has: page.getByTestId('demo-transcript') });
  await demo.waitFor();
  await demo.getByRole('button', { name: '暂停', exact: true }).waitFor();
  const stages = new Set();
  const stageTimeline = [];
  let sawThinking = false;
  let sawTyping = false;
  const playbackStarted = Date.now();
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    const text = await demo.locator('aside').innerText();
    sawThinking ||= (await demo.locator('[data-demo-phase="thinking"]').count()) > 0;
    sawTyping ||= (await demo.locator('[data-demo-phase="typing"]').count()) > 0;
    for (const stage of ['等待设计', '设计草图', '方案整合', '初版实现', '审查与修正', '已完善'])
      if (text.includes(stage) && !stages.has(stage)) {
        stages.add(stage);
        stageTimeline.push({ stage, elapsedMs: Date.now() - playbackStarted });
      }
    if (await demo.getByRole('link', { name: '创建我的猫猫 →', exact: true }).count()) break;
    await page.waitForTimeout(400);
  }
  assert.equal(stages.size, 6);
  assert.ok(sawThinking && sawTyping, 'The real player must show thinking and progressive reply phases');
  assert.equal(creates.length, 0, 'Mock collaboration must never create real roles');
  const previewObserver = await exerciseDemoPreview(journey, '端到端验收任务');
  await journey.screenshot('progressive-demo-completed');
  await log('automatic-mock-a2a-and-interactive-preview', {
    stages: [...stages],
    stageTimeline,
    sawThinking,
    sawTyping,
    previewObserver,
  });
  await demo.getByRole('link', { name: '创建我的猫猫 →', exact: true }).click();
  const setup = page.getByTestId('recommended-team-setup');
  await setup.waitFor();
  await verifyVisibleRoute(page, journey.record, 'recommended-team-setup');
  for (const label of ['Codex', 'Claude Code', 'DSH', 'Kimi', 'Pi']) {
    const checkbox = page.getByRole('checkbox', { name: `加入 ${label} 伙伴`, exact: true });
    assert.ok(await checkbox.isEnabled());
    assert.ok(await checkbox.isChecked());
  }
  assert.equal(await setup.getByText('Claude Code 尚未登录', { exact: true }).count(), 0);
  await journey.screenshot('five-detected-clients');
  await page.getByRole('button', { name: '一键创建 5 位伙伴', exact: true }).click();
  await setup.waitFor({ state: 'hidden', timeout: 60000 });
  const cats = (await request('/api/cats')).cats;
  assert.equal(cats.length, 5);
  assert.equal(creates.length, 5);
  assert.deepEqual(capabilitySettingsReads, [], 'Opening capability settings must not heal a broken first-run test');
  for (const cat of cats) assert.ok(cat.avatar && cat.avatar !== '/avatars/default.png');
  await log('one-click-created-five-real-roles');
  return cats;
}
