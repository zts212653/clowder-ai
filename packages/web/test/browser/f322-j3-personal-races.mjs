import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

function latch() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
/** Invalidation during preparation, changed full set and real failed HTTP save; original routes and writer stay in use. */
export async function assertPersonalMailboxRaces(page, fixture, language, evidence) {
  const before = fixture.preferenceSnapshot();
  const writes = () =>
    fixture.mutations.filter((item) => item.path === '/api/config/ignored-items' && item.method === 'PATCH').length;
  const initialWrites = writes();
  await page.getByTestId('mailbox-button').click();
  const ignoreAll = page.getByTestId('mailbox-mentions-ignore-all');
  await ignoreAll.waitFor();
  const prepare = latch();
  const prepareSeen = latch();
  const read = latch();
  const readSeen = latch();
  const previewPattern = '**/api/concierge/work/mentions/handling-preview?*';
  const readPattern = '**/api/concierge/work/decisions?*';
  const deferPreview = async (route) => {
    prepareSeen.release();
    await prepare.promise;
    await route.continue();
  };
  const deferRead = async (route) => {
    readSeen.release();
    await read.promise;
    await route.continue();
  };
  await page.route(previewPattern, deferPreview);
  await ignoreAll.click();
  await prepareSeen.promise;
  await page.route(readPattern, deferRead);
  await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:user-mention-updated')));
  await readSeen.promise;
  await page.locator('[data-testid="mailbox-item"][data-stale="true"]').first().waitFor();
  prepare.release();
  await page.getByTestId('mailbox-bulk-ignore-notice').waitFor();
  assert.equal(await page.getByTestId('mailbox-mentions-ignore-confirm').count(), 0);
  assert.equal(writes(), initialWrites);
  await page.screenshot({ path: path.join(evidence, 'j3-ignore-withdrawn-read.png') });
  read.release();
  await page.unroute(previewPattern, deferPreview);
  await page.unroute(readPattern, deferRead);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="mailbox-mentions-ignore-all"]')?.disabled === false,
  );

  await ignoreAll.click();
  const confirm = page.getByTestId('mailbox-mentions-ignore-confirm');
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /26/);
  const newer = fixture.appendMention();
  await confirm.click();
  await page.getByTestId('mailbox-bulk-ignore-notice').waitFor();
  assert.equal(
    writes(),
    initialWrites,
    'a changed message version aborts the complete-set confirmation without a PATCH',
  );
  await page.getByTestId('mailbox-mention-preview').filter({ hasText: newer.content }).waitFor();
  assert.deepEqual(fixture.preferenceSnapshot(), before);

  await page.waitForFunction(
    () => document.querySelector('[data-testid="mailbox-mentions-ignore-all"]')?.disabled === false,
  );
  fixture.failNextPreferenceWrite();
  await ignoreAll.click();
  await confirm.waitFor();
  const failed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/config/ignored-items' && response.request().method() === 'PATCH',
  );
  await confirm.click();
  assert.equal((await failed).status(), 503);
  await page.getByTestId('mailbox-personal-notice').waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="mailbox-mentions-ignore-all"]')?.disabled === false,
  );
  const failedSaveNotice = await page.getByTestId('mailbox-personal-notice').innerText();
  assert.equal(
    failedSaveNotice,
    language === 'en'
      ? 'Your ignore preferences could not be verified. Please retry.'
      : '暂时无法确认你的忽略记录，请重试。',
    'a settled same-owner read must preserve the 503 write failure instead of claiming a collection change',
  );
  assert.equal(await page.getByTestId('mailbox-personal-undo').count(), 0);
  assert.equal(writes(), initialWrites + 1);
  assert.deepEqual(fixture.preferenceSnapshot(), before, 'failed save never hides or changes the real preference file');
  await page.getByTestId('mailbox-mention-preview').filter({ hasText: newer.content }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'j3-ignore-failed-save.png') });
  await page.getByTestId('mailbox-close').click();
  await writeFile(
    path.join(evidence, 'j3-ignore-races.json'),
    JSON.stringify(
      {
        language,
        controlled: true,
        withdrawnReadWrites: 0,
        changedSetWrites: 0,
        failedSaveStatus: 503,
        failedSaveNotice,
        preferenceUnchanged: true,
        newerMessageId: newer.id,
      },
      null,
      2,
    ),
  );
}
