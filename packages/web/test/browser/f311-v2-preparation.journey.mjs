import assert from 'node:assert/strict';

/** Read exact archived submissions through the v2 host, including their original cross-links. */
export async function verifyV2PreparationPages({ page, main, projection, capture, label }) {
  const reading = main.getByTestId('evolution-preparation-workspace');
  const sections = projection.preparation.sections;
  for (const section of ['object_map', 'success_contract', 'measurement_plan', 'baseline_diagnosis']) {
    await reading.locator(`[data-preparation-section="${section}"]`).click();
    await page.waitForFunction(
      (key) => document.querySelector('[data-testid="evolution-preparation-workspace"]')?.dataset.activeSection === key,
      section,
    );
    const body = sections[section].current.submission.body;
    await reading.getByText(body.summary, { exact: true }).waitFor();
    const text = await reading.textContent();
    for (const unknown of body.unknowns) assert.ok(text.includes(unknown), `${label}/${section}: unknown retained`);
    assert.ok(text.includes(body.nextAction));
    assert.ok(text.includes('活动状态待核实'));
    if (section === 'object_map') {
      assert.equal(await reading.locator('[data-preparation-item]').count(), body.items.length);
      for (const item of body.items) {
        assert.ok(text.includes(item.label));
        assert.ok(text.includes(item.why));
        assert.ok(text.includes(item.scope));
        if (item.recommendation) assert.ok(text.includes(item.recommendation.reason));
      }
    } else if (section === 'success_contract') {
      assert.equal(await reading.locator('[data-preparation-criterion]').count(), body.criteria.length);
      for (const criterion of body.criteria) {
        assert.ok(text.includes(criterion.counterexample));
        assert.ok(text.includes(criterion.estimator));
        assert.ok(text.includes(criterion.payer.detail));
      }
    } else if (section === 'measurement_plan') {
      assert.equal(await reading.locator('[data-gt-source-key]').count(), body.gtSources.length);
      for (const source of body.gtSources) {
        assert.ok(text.includes(source.collection.method));
        assert.ok(text.includes(source.validity.detail));
        assert.ok(text.includes(source.cost.detail));
      }
      assert.equal(await reading.locator('[data-preparation-item]').count(), body.conditions.length);
      assert.ok(text.includes('实验条件'));
      assert.ok(text.includes('比较约定'));
    } else {
      assert.equal(await reading.locator('.evolution-preparation-fact-card').count(), body.facts.length);
      assert.equal(
        await reading.locator('.evolution-preparation-explanations > article').count(),
        body.competingExplanations.length,
      );
      for (const explanation of body.competingExplanations) {
        assert.ok(text.includes(explanation.hypothesis));
        assert.ok(text.includes(explanation.discriminatingNextStep));
      }
    }
    await capture(page, `s2-${label}-${section}`);
  }
  const criterion = sections.success_contract.current.submission.body.criteria[0];
  const sourceKey = criterion.gtSourceKeys[0];
  await reading.locator('[data-preparation-section="success_contract"]').click();
  const rubric = reading.locator(`[data-preparation-criterion="${criterion.criterionId}"]`);
  await rubric.locator(':scope > summary').click();
  await rubric.locator(`[data-gt-source-jump="${sourceKey}"]`).click();
  await reading.locator(`[data-gt-source-key="${sourceKey}"][data-focused="true"]`).waitFor();
  await reading.getByRole('button', { name: `返回规约：${criterion.label}`, exact: true }).click();
  assert.equal(await rubric.getAttribute('open'), '');
  await capture(page, `s2-${label}-rubric-return`);

  // Exact source coordinates are from the read snapshot. The isolated host does
  // not substitute a fake owner message when its original conversation is absent.
  await reading.locator('[data-preparation-section="object_map"]').click();
  const firstItem = reading.locator('[data-preparation-item]').first();
  await firstItem.locator(':scope > summary').click();
  const original = sections.object_map.current.evidenceSources[0].refs.find(
    (ref) => ref.status === 'available' && ref.threadId && ref.messageId,
  );
  assert.ok(original, 'snapshot must retain a readable source coordinate');
  const sourceButton = firstItem.getByRole('button', { name: '回读来源原文', exact: true }).first();
  await sourceButton.scrollIntoViewIfNeeded();
  const readingTop = await main.evaluate((node) => node.scrollTop);
  await sourceButton.click();
  await page.waitForURL((url) => url.pathname === `/thread/${original.threadId}`);
  await capture(page, `s2-${label}-source-location`);
  await page.goBack();
  // Source navigation reveals Chat and exits its temporary overlay. Returning
  // keeps the original project tab; reopen its saved main reading explicitly.
  await main.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
  await reading.locator('[data-preparation-section="object_map"][aria-selected="true"]').waitFor();
  assert.equal(await firstItem.getAttribute('open'), '');
  const returnedTop = await main.evaluate((node) => node.scrollTop);
  assert.ok(
    Math.abs(returnedTop - readingTop) <= 2,
    `source return preserves reading position: ${readingTop} -> ${returnedTop}`,
  );
  await reading.locator('[data-preparation-section="success_contract"]').click();

  // Returning from rail to main must retain the chosen section and expanded criterion.
  await main.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
  const detail = page.getByTestId('capability-evolution-program-detail');
  await detail.getByRole('button', { name: '在主区展开阅读', exact: true }).click();
  await reading.locator('[data-preparation-section="success_contract"][aria-selected="true"]').waitFor();
  assert.equal(await rubric.getAttribute('open'), '');
}
