import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { COMPANION_THREAD, OTHER_THREAD, PNG } from './f317-companion-entry.fixture.mjs';
import { createCompanionEntryHarness } from './f317-companion-entry.harness.mjs';
import './f317-home-work-display.journey.mjs';

const harness = createCompanionEntryHarness();
before(harness.start);
after(harness.stop);
const input = (page) => page.getByRole('textbox', { name: '消息输入框' });
const screenshot = async (page, name) => {
  if (process.env.F317_SUNSET_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.F317_SUNSET_SCREENSHOTS}/${name}.png` });
};

test('390-wide stopped, missing and failed desktop states retain an unobstructed explicit original-thread entry', async () => {
  for (const { mode, presentation } of ['classic', 'v2'].flatMap((presentation) =>
    ['missing', 'stopped', 'failed'].map((mode) => ({ mode, presentation })),
  )) {
    const f = await harness.open(mode, 390, presentation);
    try {
      assert.equal(await f.page.getByTestId('concierge-ball-wrapper').count(), 0);
      assert.equal(await f.page.getByTestId('concierge-desktop-fallback').count(), 0);
      await f.companion();
      await f.page.getByText('原伴随历史与消息 ID 保持不变', { exact: true }).waitFor();
      await f.page.reload();
      await f.page.getByRole('region', { name: '伴随对话入口' }).waitFor();
      assert.equal(f.fixture.calls.filter((x) => x.path === '/api/concierge/thread' && x.method === 'POST').length, 1);
      assert.equal(f.fixture.calls.filter((x) => x.path === '/api/concierge/config' && x.method === 'PUT').length, 0);
      assert.equal(await f.page.getByTestId('concierge-ball-wrapper').count(), 0);
      assert.deepEqual(await f.page.evaluate(() => window.__captureAttempts), []);
      await screenshot(f.page, `entry-${mode}-${presentation}-390`);
    } finally {
      await f.close();
    }
  }
});

test('the same canonical Chat sends text and an image and restores the original work draft on return', async () => {
  const f = await harness.open();
  try {
    await input(f.page).fill('原工作未发送草稿');
    assert.ok(
      (await f.page.evaluate(() => sessionStorage.getItem('cat-cafe:thread-drafts')))?.includes('原工作未发送草稿'),
      'React owns the typed original draft',
    );
    await f.companion();
    await input(f.page).fill('同一伴随对话的合成图文');
    await f.page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: PNG });
    await f.page.getByRole('button', { name: '发送消息', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="消息输入框"]')?.value === '');
    assert.equal(
      await f.page.locator('[data-message-id^="saved-send-"]').count(),
      0,
      'admission clears the composer without creating an optimistic History message',
    );
    const sent = f.fixture.calls.find((x) => x.path === '/api/messages' && x.method === 'POST');
    assert.ok(sent);
    assert.ok(sent.body.includes(COMPANION_THREAD));
    assert.ok(sent.body.includes('同一伴随对话的合成图文'));
    await f.page.reload();
    await f.page.getByText('同一伴随对话的合成图文', { exact: true }).waitFor();
    assert.ok(await f.page.locator('img[src*="f317-synthetic.png"]').count());
    assert.equal(
      f.fixture.drafts.get(OTHER_THREAD)?.draft?.text,
      '原工作未发送草稿',
      'the original owner draft was saved before reload',
    );
    await f.page.goBack();
    await f.page.waitForURL(`**/thread/${OTHER_THREAD}?shell=v2`);
    await f.page.waitForFunction(
      () => document.querySelector('textarea[aria-label="消息输入框"]')?.value === '原工作未发送草稿',
    );
    assert.equal(await input(f.page).inputValue(), '原工作未发送草稿');
    assert.deepEqual(await f.page.evaluate(() => window.__captureAttempts), []);
  } finally {
    await f.close();
  }
});

test('saved memory cards still navigate to the exact original thread and allow return', async () => {
  const f = await harness.open();
  try {
    await f.companion();
    await f.page.getByRole('button', { name: '查看原记录', exact: true }).click();
    await f.page.waitForURL(`**/thread/${OTHER_THREAD}`);
    await f.page.getByText('原工作的精确记忆锚点', { exact: true }).waitFor();
    await f.page.goBack();
    await f.page.waitForURL(`**/thread/${COMPANION_THREAD}`);
    await f.page.getByRole('region', { name: '伴随对话入口' }).waitFor();
  } finally {
    await f.close();
  }
});

test('relay, investigation confirmation, cancellation and saved result continue through shared rich cards', async () => {
  const f = await harness.open();
  try {
    await f.companion();
    await f.page.getByRole('button', { name: '确认原传话', exact: true }).click();
    const relay = f.fixture.calls.find((x) => x.path === '/api/concierge/relay');
    assert.ok(relay);
    assert.deepEqual(JSON.parse(relay.body), {
      targetThreadId: OTHER_THREAD,
      targetCats: ['codex61-sol'],
      originalText: '保留这段原话',
      sourceMessageId: 'saved-history',
      conciergeThreadId: COMPANION_THREAD,
    });
    await f.page.getByRole('button', { name: '取消第二计划', exact: true }).click();
    await f.page.getByRole('button', { name: '确认调查', exact: true }).click();
    await f.page.getByTestId('investigation-cancel').click();
    await f.page.getByText('调查已取消', { exact: true }).waitFor();
    f.fixture.setJobStatus('done');
    await f.page.reload();
    await f.page.getByTestId('investigation-report').waitFor();
    await f.page.getByText('合成调查结果已回流', { exact: true }).waitFor();
    assert.equal(f.fixture.calls.filter((x) => x.path.endsWith('/triage/investigate-plan/confirm')).length, 1);
    assert.equal(f.fixture.calls.filter((x) => x.path.endsWith('/triage/cancel-plan/cancel')).length, 1);
    assert.equal(f.fixture.calls.filter((x) => x.path.endsWith('/investigation/synthetic-job/cancel')).length, 1);
  } finally {
    await f.close();
  }
});

test('page preview, one-shot authorization, cancellation and result readback remain in the explicit conversation', async () => {
  const f = await harness.open();
  try {
    await f.companion();
    const preview = f.page.getByRole('button', { name: '检查具名页面', exact: true });
    const box = await preview.boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= 900,
      'page permission entry stays visible beside the original history',
    );
    await preview.click();
    await f.page.getByRole('button', { name: '取消／撤销', exact: true }).click();
    await f.page.getByRole('button', { name: '检查具名页面', exact: true }).click();
    await f.page.getByRole('button', { name: '允许这次修改', exact: true }).click();
    await f.page.getByText('已核对页面修改，结果保留在原页面。', { exact: true }).waitFor();
    const confirms = f.fixture.calls.filter((x) => x.path.endsWith('/page-action/confirm'));
    assert.equal(confirms.length, 1);
    assert.deepEqual(JSON.parse(confirms[0].body), { previewId: 'opaque-preview-1' });
    const cancelled = f.fixture.calls.find((x) => x.path === '/api/concierge/page-action' && x.method === 'DELETE');
    assert.ok(cancelled);
    assert.deepEqual(JSON.parse(cancelled.body), { previewId: 'opaque-preview-1' });
    await f.page.reload();
    await f.page.getByText('已核对页面修改，结果保留在原页面。', { exact: true }).waitFor();
    await screenshot(f.page, 'page-confirmation-result');
  } finally {
    await f.close();
  }
});

test('stored settings and the existing guide engine remain reachable through the original conversation', async () => {
  const f = await harness.open();
  try {
    await f.companion();
    await f.page.waitForFunction(() => typeof window.__startGuide === 'function');
    await f.page.evaluate((threadId) => window.__startGuide('synthetic-guide', threadId), COMPANION_THREAD);
    await f.page.getByText('合成引导仍定位原输入框', { exact: true }).waitFor();
    const exit = f.page.getByRole('button', { name: '退出引导', exact: true });
    await exit.click();
    assert.ok(f.fixture.calls.some((x) => x.path === '/api/guide-actions/cancel'));
    await f.page.getByRole('link', { name: '伴随设置', exact: true }).click();
    await f.page.waitForURL('**/settings?s=concierge');
    await f.page.locator('input[value="合成保存人设"]').waitFor();
    assert.equal(
      await f.page
        .locator('select')
        .filter({ has: f.page.locator('option[value="codex61-sol"]') })
        .inputValue(),
      'codex61-sol',
    );
    assert.deepEqual(f.fixture.config.ballPosition, { x: 83, y: 127 });
    assert.equal(f.fixture.config.muted, true);
    assert.equal(f.fixture.calls.filter((x) => x.path === '/api/concierge/config' && x.method === 'PUT').length, 0);
  } finally {
    await f.close();
  }
});
