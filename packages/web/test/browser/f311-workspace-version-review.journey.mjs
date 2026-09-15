import assert from 'node:assert/strict';

export async function verifyRichVersionReview({
  page,
  targetUrl,
  navigateShell,
  capture,
  assertContained,
  programFixture,
  assetReviewFixture,
}) {
  const module = await import(
    '../../src/components/capability-evolution/__tests__/evolution-owner-exploration-fixture.ts'
  );
  const { ownerExplorationFixture } = module.default ?? module;
  let current = 'v2';
  await page.route('**/api/capability-evolution/programs**', (route) => {
    assert.equal(route.request().method(), 'GET');
    const url = new URL(route.request().url());
    const projection = programFixture('observing');
    projection.program.displayName = '契约样本 · 文档审阅方式';
    projection.program.objectRef.ownerStateRef = 'capability:契约样本·文档审阅方式';
    let body = url.pathname.endsWith('/programs') ? { programs: [projection] } : projection;
    if (url.pathname.endsWith('/exploration')) {
      body = ownerExplorationFixture(current);
      body.objectRef = projection.program.objectRef;
    }
    if (url.pathname.endsWith('/asset-review')) {
      const selected = url.searchParams.get('selectedVersionRef');
      body = assetReviewFixture(selected ? JSON.parse(selected).version : current, current);
      body.objectRef = projection.program.objectRef;
      if (body.selected?.diff.status === 'available')
        body.selected.diff.summary = `${body.selected.versionRef.version}：先明确审阅范围，再用一个反例检查边界。\n保留原来的校对标准，新增可复核的来源入口。`;
      const labels = {
        comparison_baseline: '原有审阅结果',
        candidate_independent_verification: '独立样本核验',
        post_adoption_observation: '采用后的观察记录',
      };
      for (const evidence of body.selected?.evidence ?? [])
        evidence.label = `${evidence.assetVersionRef.version} · ${labels[evidence.role]}`;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await navigateShell(page, targetUrl('history', 'v1'));
  const program = page.getByTestId('evolution-program-surface');
  await program.getByRole('heading', { name: '留下了哪些改变' }).waitFor();
  await page.getByTestId('f307-tab-evolution-program').getByText('契约样本 · 文档审阅方式', { exact: true }).waitFor();
  await program.getByText('v1 · 原有审阅结果', { exact: true }).waitFor();
  assert.equal(await program.getByText('v2 · 原有审阅结果', { exact: true }).count(), 0);
  await capture(page, 'fixture-history');
  await program.getByText('查看版本分支', { exact: true }).click();
  await capture(page, 'fixture-branch');
  current = 'v3';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const liveCurrent = program
    .locator('section[aria-label="阅读版本"] button')
    .filter({ hasText: '保留的另一个候选' })
    .filter({ hasText: '当前采用' });
  await liveCurrent.waitFor();
  assert.match(await liveCurrent.innerText(), /v3/);
  await program.getByText('v1 · 原有审阅结果', { exact: true }).waitFor();
  await program.getByText('相对当前采用 v3', { exact: true }).waitFor();
  await assertContained(program);
  await navigateShell(page, targetUrl('judgment', 'v2'));
  await program.locator('.exploration-owner-evidence > summary').click();
  await program.getByText('后续任务已实际使用这个版本', { exact: true }).waitFor();
  await program.getByText('v2 · 原有审阅结果', { exact: true }).waitFor();
  assert.equal(await program.getByText('v1 · 原有审阅结果', { exact: true }).count(), 0);
  await capture(page, 'fixture-review');
  await program.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 960 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth >= 355,
  );
  await assertContained(program);
  const narrowRail = await program.boundingBox();
  await capture(page, 'fixture-narrow-detail');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="evolution-program-surface"]')?.clientWidth === 390,
  );
  await assertContained(program);
  const mobileRail = await program.boundingBox();
  await capture(page, 'fixture-mobile-detail');
  await program.getByRole('button', { name: '展开阅读 →', exact: true }).click();
  await program.getByRole('tab', { name: '探索工作面' }).waitFor({ timeout: 5000 });
  await assertContained(program);
  await capture(page, 'fixture-mobile-review');
  await program.getByRole('tab', { name: '更改历史' }).click();
  await program.getByRole('heading', { name: '留下了哪些改变' }).waitFor();
  await program.getByRole('button', { name: '← 返回详情', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  for (const name of ['提出目标', '准备', '探索进化', '后续沿用'])
    await program
      .getByRole('navigation', { name: '能力进化旅程' })
      .getByRole('button', { name, exact: true })
      .waitFor({ state: 'visible' });
  await assertContained(program);
  const compactRail = await program.boundingBox();
  await capture(page, 'fixture-compact-detail');
  return {
    narrowRail,
    mobileRail,
    compactRail,
    claim:
      'Fixture-only rich version/diff/owner current/evidence/actual-use contracts in the real shell; these receipts are not production outcomes.',
  };
}
