import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Real preview route and original owner-private file writer, on explicitly controlled mentions. */
export async function assertPersonalMailboxJourney(page, fixture, language, evidence) {
  const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
  const original = await composer.inputValue();
  const openIgnored = async () => {
    await page.getByTestId('mailbox-history').click();
    await page.getByTestId('mailbox-history-tab-ignored').click();
  };
  const readAllDisplayed = async (count) => {
    for (let step = 0; step < 5; step++) {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-history-row"]').length > 0);
      if ((await page.getByTestId('mailbox-history-row').count()) >= count) break;
      const more = page.getByTestId('mailbox-history-load-more');
      if (!(await more.count())) break;
      const before = await page.getByTestId('mailbox-history-row').count();
      await more.click();
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('[data-testid="mailbox-history-row"]').length > n ||
          !document.querySelector('[data-testid="mailbox-history-load-more"]'),
        before,
      );
    }
    assert.equal(await page.getByTestId('mailbox-history-row').count(), count);
  };
  await composer.evaluate((input) => input.setSelectionRange(3, 8));
  await page.getByTestId('mailbox-button').click();
  await page.getByTestId('mailbox-mentions-ignore-all').waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-testid="mailbox-panel"]');
      return (
        panel &&
        getComputedStyle(panel).opacity === '1' &&
        panel.getAnimations().every((animation) => animation.playState === 'finished')
      );
    });
    await page.screenshot({ path: path.join(evidence, `j3-pending-${language}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId('mailbox-mentions-ignore-all').click();
  const confirm = page.getByTestId('mailbox-mentions-ignore-confirm');
  assert.match(await confirm.innerText(), new RegExp(String(fixture.mentionCount)));
  const savedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/config/ignored-items' && response.request().method() === 'PATCH',
  );
  await confirm.click();
  assert.equal((await savedResponse).status(), 200);
  await page.getByTestId('mailbox-personal-undo').waitFor();
  await page
    .getByTestId('mailbox-group-mentions')
    .getByText(language === 'en' ? 'No @you requests' : '暂无 @你 请求', { exact: true })
    .waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === '1');
  const saved = await fixture.readPreferences();
  const entries = saved.ignoredItems.owners['default-user'].entries.filter(
    (entry) => entry.coordinate.kind === 'mailbox',
  );
  assert.equal(entries.length, fixture.mentionCount, 'all versions across the 20-row boundary were actually persisted');
  assert.equal(new Set(entries.map((entry) => entry.coordinate.decisionRef)).size, fixture.mentionCount);
  assert.match(await page.getByTestId('mailbox-button').getAttribute('aria-label'), /1 件|1 items/);
  await page.getByTestId('mailbox-personal-undo').waitFor({ state: 'detached', timeout: 15000 });
  assert.deepEqual(
    await fixture.readPreferences(),
    saved,
    'recent UI receipt expiry never expires the actual TTL=0 preferences',
  );
  await page.getByTestId('mailbox-history').waitFor();
  await page.screenshot({ path: path.join(evidence, 'j3-inbox-bulk-ignore.png') });
  await page.reload();
  await page.getByTestId('file-block-open').waitFor();
  await page.getByTestId('mailbox-button').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === '1');
  await openIgnored();
  await readAllDisplayed(fixture.mentionCount);
  assert.match(await page.getByTestId('mailbox-button').getAttribute('aria-label'), /1 件|1 items/);
  assert.equal(await page.getByTestId('mailbox-mention-resolve').count(), 0);
  const recoveredCoordinate = entries[0].coordinate;
  const historyRow = page.locator(
    `[data-testid="mailbox-history-row"][data-decision-ref="${recoveredCoordinate.decisionRef}"]`,
  );
  await historyRow.getByTestId('mailbox-history-item-toggle').click();
  const recoveredRow = historyRow.getByTestId('mailbox-item');
  assert.ok((await recoveredRow.getAttribute('data-row-key')).includes(recoveredCoordinate.decisionRef));
  await recoveredRow.getByTestId('mailbox-item-restore').click();
  await historyRow.waitFor({ state: 'detached' });
  await readAllDisplayed(fixture.mentionCount - 1);
  const restored = await fixture.readPreferences();
  assert.equal(
    restored.ignoredItems.owners['default-user'].entries.filter((entry) => entry.coordinate.kind === 'mailbox').length,
    fixture.mentionCount - 1,
  );
  assert.deepEqual(
    restored.ignoredItems.owners['default-user'].entries.filter((entry) => entry.coordinate.kind === 'mailbox'),
    entries.filter((entry) => JSON.stringify(entry.coordinate) !== JSON.stringify(recoveredCoordinate)),
    'only the exact selected version is restored; the other 25 remain unchanged',
  );
  await page.screenshot({ path: path.join(evidence, 'j3-inbox-ignored-recovery.png') });
  await page.getByTestId('mailbox-handled-back').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === '1');
  await page.getByTestId('mailbox-mention-preview').waitFor();
  await page.getByTestId('mailbox-close').click();
  assert.equal(await composer.inputValue(), original);
  assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
  await writeFile(
    path.join(evidence, 'j3-personal-mailbox.json'),
    JSON.stringify(
      {
        language,
        controlled: true,
        all: fixture.mentionCount,
        persisted: entries.length,
        recovered: 1,
        preferenceRevision: restored.ignoredItems.owners['default-user'].revision,
        unchangedDraft: original,
        selection: [3, 8],
        canonicalMentionHandlingPosts: fixture.mutations.filter(
          (m) => m.method === 'POST' && m.path.startsWith('/api/concierge/work/mentions/'),
        ),
      },
      null,
      2,
    ),
  );
  assert.equal(
    fixture.mutations.filter((m) => m.method === 'POST' && m.path.startsWith('/api/concierge/work/mentions/')).length,
    0,
  );

  // Canonical history is a different lane: an older batch has an individual recovery path, independent of last-batch undo.
  await page.getByTestId('mailbox-button').click();
  await page.getByTestId('mailbox-history').click();
  await page.getByTestId('mailbox-history-tab-mentions').click();
  const olderHistory = page.getByTestId('mailbox-history-row').filter({ hasText: fixture.handledHistory[0].threadId });
  await olderHistory.getByTestId('mailbox-history-item-toggle').click();
  const older = olderHistory.getByTestId('mailbox-item');
  assert.equal(
    await page.getByTestId('mailbox-mentions-undo').innerText(),
    language === 'en' ? 'Undo last handled batch (1 item)' : '撤销刚才的批量处理（1 件）',
  );
  assert.equal(await page.getByTestId('mailbox-item-ignore').count(), 0);
  assert.equal(await page.getByTestId('mailbox-item-restore').count(), 0);
  const canonicalRestore = older.getByTestId('mailbox-mention-restore');
  assert.equal(await canonicalRestore.innerText(), language === 'en' ? 'Return to to-do' : '放回待办');
  await page.screenshot({ path: path.join(evidence, 'j3-handled-individual-recovery.png') });
  await canonicalRestore.click();
  await older.waitFor({ state: 'detached' });
  const remainingHistory = await fixture.readHandledMentions();
  assert.equal(remainingHistory.length, 1);
  assert.equal(
    remainingHistory[0].id,
    fixture.handledHistory[1].id,
    'restoring the older item leaves the latest batch handled',
  );
  assert.deepEqual(await fixture.readPreferences(), restored, 'canonical restoration never writes ignore preferences');
  const recoveryPosts = fixture.mutations.filter(
    (m) => m.method === 'POST' && m.path.startsWith('/api/concierge/work/mentions/'),
  );
  assert.deepEqual(recoveryPosts, [{ method: 'POST', path: '/api/concierge/work/mentions/restore' }]);
  await page.getByTestId('mailbox-handled-back').click();
  await openIgnored();
  await readAllDisplayed(fixture.mentionCount - 1);
  await page.getByTestId('mailbox-history-select').click();
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
  const restoredAll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/config/ignored-items' && response.request().method() === 'PATCH',
  );
  await page.getByTestId('mailbox-history-restore-selected').click();
  assert.equal((await restoredAll).status(), 200);
  const expectedEmpty = language === 'en' ? 'No ignored items yet' : '还没有忽略的事项';
  await page.getByText(expectedEmpty, { exact: true }).waitFor();
  assert.equal(
    (await fixture.readPreferences()).ignoredItems.owners['default-user'].entries.filter(
      (entry) => entry.coordinate.kind === 'mailbox',
    ).length,
    0,
  );
  await page.screenshot({ path: path.join(evidence, 'j3-ignored-empty.png') });
  await page.getByTestId('mailbox-close').click();
  assert.equal(await composer.inputValue(), original);
  assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
  await writeFile(
    path.join(evidence, 'j3-handled-recovery.json'),
    JSON.stringify(
      {
        language,
        controlled: true,
        olderRequest: fixture.handledHistory[0].id,
        remainingHandledRequest: remainingHistory[0].id,
        preferenceUnchanged: true,
        canonicalHistoryRestores: recoveryPosts,
        unchangedDraft: original,
        selection: [3, 8],
      },
      null,
      2,
    ),
  );
}
