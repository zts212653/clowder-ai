import assert from 'node:assert/strict';

export async function verifyJourneyProgress({
  page,
  projection,
  threadId,
  targetUrl,
  navigateShell,
  capture,
  assertContained,
}) {
  const programId = projection.program.programId;
  projection.origin = { threadId, title: '让交接记录更清楚', createdByCatId: 'codex-sol' };
  projection.program.displayName = '交接记录评估';
  const messages = [];
  await page.route('**/api/capability-evolution/programs**', (route) => {
    assert.equal(
      route.request().method(),
      'GET',
      'viewing or asking for work must not manufacture Program advancement',
    );
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/asset-review'))
      return route.fulfill({ status: 422, json: { error: 'owner_version_review_unavailable' } });
    return route.fulfill({ json: url.pathname.endsWith('/programs') ? { programs: [projection] } : projection });
  });
  await page.route('**/api/messages', (route) => {
    assert.equal(route.request().method(), 'POST');
    const body = route.request().postDataJSON();
    assert.equal(body.threadId, threadId);
    assert.equal(body.messageDisposition, 'continue_current');
    assert.equal(body.deliveryMode, undefined, 'requesting progress does not force-cancel an invocation');
    assert(body.content.startsWith('@codex-sol\n'));
    assert(body.content.includes(programId));
    messages.push(body);
    return route.fulfill({ status: 202, json: { status: 'queued', userMessageId: 'contract-progress-request' } });
  });
  await navigateShell(page, targetUrl());
  const surface = page.getByTestId('evolution-program-surface');
  const journey = surface.getByRole('navigation', { name: '能力进化旅程' });
  await surface.getByRole('button', { name: '请猫猫推进评估', exact: true }).waitFor();
  const labels = ['提出目标', '准备', '探索进化', '后续沿用'];
  for (let index = 0; index < labels.length; index += 1) {
    await journey.getByRole('button', { name: labels[index], exact: true }).click();
    await surface.locator(`[data-journey-panel="${index}"]`).waitFor();
    assert.equal(
      await journey.getByRole('button', { name: labels[index], exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(await journey.locator('[aria-current="step"]').innerText(), '提出目标');
  }
  assert.equal(messages.length, 0, 'stage navigation never sends a hidden request');
  await capture(page, 'journey-main');
  await surface.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
  await surface.locator('[data-journey-panel="3"]').waitFor();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth === 320,
  );
  for (const label of labels) assert(await journey.getByRole('button', { name: label, exact: true }).isVisible());
  await journey.getByRole('button', { name: '准备', exact: true }).focus();
  await page.keyboard.press('Enter');
  await surface.locator('[data-journey-panel="1"]').waitFor();
  await assertContained(surface);
  await capture(page, 'journey-mobile-before-request');
  await surface.getByRole('button', { name: '请猫猫推进评估', exact: true }).click();
  await surface.getByText('推进请求已排队，等猫猫接续处理。', { exact: true }).waitFor();
  assert.equal(messages.length, 1);
  await capture(page, 'journey-mobile-receipt');
  await navigateShell(page, targetUrl());
  await surface.getByTestId('evolution-progress-receipt').waitFor();
  await surface.locator('[data-journey-panel="1"]').waitFor();
  assert.equal(messages.length, 1, 'reload preserves the receipt instead of dispatching again');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('f311-progress-requests-v1')));
  assert.equal(Object.values(persisted.state.records)[0].receipt.userMessageId, 'contract-progress-request');
  await surface.getByTestId('evolution-progress-receipt').click();
  assert.equal(new URL(page.url()).pathname, `/thread/${threadId}`);
  return {
    moments: labels,
    viewport: 320,
    requestCount: messages.length,
    threadId,
    programId,
    messageId: 'contract-progress-request',
    sequenceUnchanged: projection.program.sequence,
    truth: 'isolated-contract; real shell, synthetic canonical message response; no live cat was dispatched',
  };
}
