import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

async function waitForMailboxPaint(page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="mailbox-panel"]');
    return (
      panel &&
      getComputedStyle(panel).opacity === '1' &&
      panel.getAnimations().every((animation) => animation.playState === 'finished')
    );
  });
}

async function waitForVisibleSource(page, messageId) {
  await page.waitForFunction((messageId) => {
    const message = document.querySelector(`[data-message-id="${messageId}"]`);
    const viewport = message?.closest('[data-chat-container]');
    if (!message || !viewport) return false;
    const rect = message.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    const left = Math.max(rect.left, bounds.left, 0);
    const right = Math.min(rect.right, bounds.right, window.innerWidth);
    const top = Math.max(rect.top, bounds.top, 0);
    const bottom = Math.min(rect.bottom, bounds.bottom, window.innerHeight);
    return (
      right > left &&
      bottom > top &&
      message.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))
    );
  }, messageId);
}

async function foldMobileWorkspace(page, width, language) {
  if (width === 390 && (await page.getByTestId('contextual-workspace-host').isVisible())) {
    await page
      .getByTestId('v2-workspace-actions')
      .locator(`summary[aria-label="${language === 'en' ? 'More Workspace actions' : '更多 Workspace 操作'}"]`)
      .click();
    await page
      .getByRole('menuitem', {
        name: language === 'en' ? 'Collapse Workspace' : '收起 Workspace',
        exact: true,
      })
      .press('Enter');
    await page.getByTestId('contextual-workspace-host').waitFor({ state: 'hidden' });
  }
  if (width === 390) {
    const sidebar = page.locator('[data-testid="sidebar-collapse"]:visible');
    if (await sidebar.count()) await sidebar.click();
  }
}

/** Mouse and keyboard discovery from the actual rail/panel, original Hub history/filter/source, and back. */
export async function assertApprovalHistoryJourney(page, fixture, language, evidence) {
  const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
  const before = await composer.inputValue();
  await composer.evaluate((input) => input.setSelectionRange(3, 8));
  const stored = await fixture.approvalHistory.read();
  assert.equal(stored.length, 2);
  assert.ok(stored.every((item) => item.ownerUserId === 'default-user' && item.navigation.state === 'anchored'));
  const accepted = fixture.approvalHistory.records.find((item) => item.outcome === 'approved');
  const rejected = fixture.approvalHistory.records.find((item) => item.outcome === 'rejected');
  const observed = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await foldMobileWorkspace(page, width, language);
    await page.getByTestId('mailbox-button').click();
    const history = page.getByTestId('mailbox-history');
    await history.waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: language === 'en' ? 'Approval records' : '审批记录', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole('button', { name: language === 'en' ? 'Handled @you' : '已处理的 @你', exact: true })
        .count(),
      0,
    );
    if (width === 390) await history.press('Enter');
    else await history.click();
    await page.getByTestId('mailbox-history-tab-decisions').click();
    const row = (id) => page.locator(`[data-testid="mailbox-history-row"][data-proposal-id="${id}"]`);
    await row(accepted.proposalId).waitFor();
    assert.equal(await page.getByTestId('mailbox-history-tab-decisions').getAttribute('aria-current'), 'page');
    assert.equal(
      await page.getByTestId('approval-empty-state').count(),
      0,
      'history never opens the pending empty state',
    );
    const panel = page.getByTestId('mailbox-panel');
    const historyText = (
      await panel
        .locator('[data-testid="mailbox-title"], nav, [role="combobox"], [data-testid$="-label"]')
        .allTextContents()
    ).join('\n');
    if (language === 'en')
      assert.doesNotMatch(historyText, /[\u3400-\u9fff]/u, 'fixed history controls use the selected language');
    await page.getByRole('combobox', { name: language === 'en' ? 'Result' : '结果', exact: true }).click();
    await page.getByRole('option', { name: language === 'en' ? 'Approved' : '已同意', exact: true }).press('Enter');
    assert.equal(await row(rejected.proposalId).count(), 0);
    await waitForMailboxPaint(page);
    await page.screenshot({ path: path.join(evidence, `j3-approval-history-${language}-${width}.png`) });
    await page.getByRole('combobox', { name: language === 'en' ? 'Type' : '种类', exact: true }).click();
    await page
      .getByRole('option', { name: language === 'en' ? 'New conversation' : '新对话', exact: true })
      .press('Enter');
    const target = row(accepted.proposalId);
    assert.equal(await target.count(), 1);
    await target.getByRole('button').first().press('Enter');
    await target
      .getByRole('button', { name: language === 'en' ? 'View original ↗' : '在原处看 ↗', exact: true })
      .press('Enter');
    const originalMessage = page.locator(`[data-message-id="${accepted.origin.id}"]`);
    await originalMessage.waitFor();
    assert.match(await originalMessage.innerText(), /Controlled approved proposal origin/);
    await page.getByTestId('mailbox-handled-back').press('Enter');
    await page.getByTestId('mailbox-tab-needs-me').waitFor();
    await page.getByTestId('mailbox-close').click();
    await waitForVisibleSource(page, accepted.origin.id);
    await page.screenshot({ path: path.join(evidence, `j3-approval-origin-${language}-${width}.png`) });
    assert.equal(await composer.inputValue(), before);
    assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
    observed.push({
      width,
      proposalId: accepted.proposalId,
      sourceMessageId: accepted.origin.id,
      sourceActuallyVisible: true,
      workspaceFoldedViaOriginalMenu: width === 390,
      draftUnchanged: true,
      selection: [3, 8],
    });
  }
  assert.equal(
    fixture.mutations.filter(
      (item) => item.path.startsWith('/api/approval-hub/') || item.path.startsWith('/api/proposals/'),
    ).length,
    0,
  );
  await writeFile(
    path.join(evidence, 'j3-approval-history.json'),
    JSON.stringify(
      { language, controlled: true, originalProducer: 'F128', observed, ownerFiltered: true, writes: 0 },
      null,
      2,
    ),
  );
}
