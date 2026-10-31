import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Extends the existing physical-owner journey; no model/provider invocation or Work mutation. */
export async function assertPersonalScheduleJourney(page, fixture, language, evidence) {
  const label = (zh, en) => (language === 'en' ? en : zh);
  const openSchedule = async () => {
    await page.getByTestId('mailbox-button').click();
    await page.getByTestId('mailbox-tab-schedule').click();
    await page.getByTestId('product-schedule-panel').waitFor();
  };
  await openSchedule();
  const panel = page.getByTestId('product-schedule-panel');
  await panel.getByRole('button', { name: label('当前工作', 'Current work'), exact: true }).click();
  const original = page.locator('[data-testid="chat-input-composer-row"] textarea');
  assert.equal(await original.inputValue(), 'J3 原 Chat 草稿和选择位置');
  const work = panel.locator(`[data-subject-ref="task:work:${fixture.progress.taskId}"]`);
  const group = panel.locator('[data-schedule-state="todo"]');
  if (!(await group.evaluate((node) => node.open))) await group.locator('summary').click();
  await work.getByTestId('schedule-ask-progress').press('Enter');
  await page.waitForURL(`**/thread/${fixture.progress.threadId}`);
  const expectedQuestion = label(
    `请说说「${fixture.progress.title}」目前的进展。`,
    `Please share the current progress on “${fixture.progress.title}”.`,
  );
  const expectedDraft = `${fixture.progress.originalDraft}\n${expectedQuestion}`;
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="chat-input-composer-row"] textarea')?.value === text,
    expectedDraft,
  );
  await page.screenshot({ path: path.join(evidence, 'j3-progress-original-draft.png') });
  await page.goBack();
  await page.waitForURL(`**/thread/${fixture.threadId}`);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="chat-input-composer-row"] textarea')?.value === 'J3 原 Chat 草稿和选择位置',
  );
  assert.deepEqual(await original.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
  const savedTarget = fixture.getDraft(fixture.progress.threadId);
  assert.equal(savedTarget.text, expectedDraft);
  assert.ok(savedTarget.revision > 1, 'the original draft owner saved the question using its real revision');
  if (!(await panel.isVisible())) await openSchedule();
  await panel.getByRole('button', { name: label('当前工作', 'Current work'), exact: true }).click();
  if (!(await group.evaluate((node) => node.open))) await group.locator('summary').click();
  const counts = panel.getByTestId('schedule-personal-counts');
  const before = await counts.innerText();
  await work.getByTestId('schedule-ignore').click();
  await work.waitFor({ state: 'detached' });
  const stored = await fixture.readPreferences();
  const owner = stored.ignoredItems.owners['default-user'];
  assert.ok(
    owner.entries.some(
      (entry) =>
        entry.coordinate.kind === 'schedule' && entry.coordinate.subjectRef === `task:work:${fixture.progress.taskId}`,
    ),
  );
  await panel.getByRole('button', { name: label('收起撤销提示', 'Dismiss undo notice'), exact: true }).click();
  await page.reload();
  await page.getByTestId('file-block-open').waitFor();
  await openSchedule();
  await panel.getByRole('button', { name: label('当前工作', 'Current work'), exact: true }).click();
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-subject-ref="task:work:${id}"]`),
    fixture.progress.taskId,
  );
  await panel.getByTestId('schedule-open-ignored').click();
  await work.getByTestId('schedule-restore').waitFor();
  await page.screenshot({ path: path.join(evidence, 'j3-ignored-restoration.png') });
  await work.getByTestId('schedule-restore').click();
  await panel.getByRole('button', { name: label('当前工作', 'Current work'), exact: true }).click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="schedule-personal-counts"]')?.textContent === expected,
    before,
  );
  const restored = await fixture.readPreferences();
  assert.ok(
    !restored.ignoredItems.owners['default-user'].entries.some(
      (entry) =>
        entry.coordinate.kind === 'schedule' && entry.coordinate.subjectRef === `task:work:${fixture.progress.taskId}`,
    ),
  );
  assert.ok(
    !fixture.mutations.some(
      (entry) =>
        entry.path === '/api/messages' ||
        entry.path.startsWith('/api/entrusted-work/') ||
        entry.path.startsWith('/api/runtime-interactions/') ||
        entry.path.startsWith('/api/approval-hub/'),
    ),
    'ignore/progress must not send, wake, decide or change canonical work',
  );
  await writeFile(
    path.join(evidence, 'j3-personal-schedule.json'),
    JSON.stringify(
      {
        controlled: true,
        originalQuestion: expectedQuestion,
        targetDraft: savedTarget,
        ownerPreference: owner,
        restoredPreference: restored,
        sourceSelection: [3, 8],
        countBefore: before,
        mutations: fixture.mutations,
      },
      null,
      2,
    ),
  );
}
