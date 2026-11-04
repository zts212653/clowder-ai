import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { origin } from './fixtures/f322-chat-real-page-build.mjs';
import { createThreadDeleteProof } from './fixtures/thread-delete-proof.mjs';

const evidence = process.env.THREAD_DELETE_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'issue-1778');
let proof, browser, threads, store, messages, requests, errors, owner;
before(
  async () => {
    proof = await createThreadDeleteProof(evidence);
    ({ browser, threads, store, messages, requests, errors, owner } = proof);
  },
  { timeout: 180_000 },
);
after(async () => proof?.close());
const openPage = (...args) => proof.openPage(...args);

test(
  'production components remember deletion confirmation and restore preserved history through the production thread API',
  { timeout: 120_000 },
  async (t) => {
    proof.setSessionOwner(owner);
    const context = await browser.newContext({ viewport: { width: 1228, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    });
    const page = await openPage(context, `/thread/${threads[0].id}`);
    t.after(async () => {
      if (page.isClosed()) return;
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
      writeFileSync(
        path.join(evidence, 'failure.json'),
        JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), requests, errors }, null, 2),
      );
    });
    const first = page.locator(`[data-thread-id="${threads[0].id}"]`);
    await first.hover();
    await page.waitForFunction((id) => {
      const row = document.querySelector(`[data-thread-id="${id}"]`);
      const more = row?.querySelector('[aria-label="更多操作"]');
      return more && getComputedStyle(more).opacity === '1';
    }, threads[0].id);
    await page.screenshot({ path: path.join(evidence, '00-quick-delete-row.png') });
    await first.getByTestId('thread-quick-delete').click();
    const dialog = page.getByRole('dialog', { name: '确认删除对话' });
    const remember = dialog.getByRole('checkbox', { name: '后续不再提醒（仅普通会话）' });
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 0);
    await first.getByTestId('thread-quick-delete').click();
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    proof.setSessionOwner('thread-delete-other-owner');
    await page.evaluate(() => window.__threadDeleteRefreshSession());
    await dialog.waitFor({ state: 'detached' });
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 0);
    assert.equal(
      await page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) => key.startsWith('clowder:thread-delete-confirm:') && localStorage.getItem(key) === 'off',
        ),
      ),
      false,
    );
    proof.setSessionOwner(owner);
    await page.evaluate(() => window.__threadDeleteRefreshSession());
    assert.equal(await dialog.count(), 0);
    await first.getByTestId('thread-quick-delete').click();
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    assert.notEqual(
      await dialog
        .getByRole('button', { name: '移入回收站', exact: true })
        .evaluate((button) => getComputedStyle(button).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
    await page.screenshot({ path: path.join(evidence, '01-confirm-and-remember.png') });
    await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
    await first.waitFor({ state: 'detached' });
    await page.waitForURL(origin + '/');
    assert.ok(store.get(threads[0].id).deletedAt);
    await page.reload();
    const second = page.locator(`[data-thread-id="${threads[1].id}"]`);
    const third = page.locator(`[data-thread-id="${threads[4].id}"]`);
    const captured = Promise.withResolvers();
    const deliver = Promise.withResolvers();
    proof.delayResponse('/api/threads?view=sidebar', { captured: captured.resolve, released: deliver.promise });
    await second.hover();
    await second.getByTestId('thread-quick-delete').click();
    await captured.promise;
    await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === 'DELETE' && response.url().endsWith(threads[4].id),
      ),
      third.getByTestId('thread-quick-delete').click(),
    ]);
    assert.ok(store.get(threads[4].id).deletedAt);
    deliver.resolve();
    await second.waitFor({ state: 'detached' });
    await third.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.ok(store.get(threads[1].id).deletedAt);
    const busy = page.locator(`[data-thread-id="${threads[2].id}"]`);
    await busy.hover();
    await busy.getByTestId('thread-quick-delete').click();
    await page.getByText('猫猫正在工作中，请等待当前任务完成后再删除对话。', { exact: true }).waitFor();
    assert.equal(Boolean(store.get(threads[2].id).deletedAt), false);
    const capturedTrash = Promise.withResolvers();
    const deliverTrash = Promise.withResolvers();
    proof.delayResponse('/api/threads?deleted=true', {
      captured: capturedTrash.resolve,
      released: deliverTrash.promise,
    });
    await page.getByTestId('trash-bin-toggle').click();
    await capturedTrash.promise;
    const trashRefreshTarget = page.locator(`[data-thread-id="${threads[5].id}"]`);
    await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === 'DELETE' && response.url().endsWith(threads[5].id),
      ),
      trashRefreshTarget.getByTestId('thread-quick-delete').click(),
    ]);
    await trashRefreshTarget.waitFor({ state: 'detached' });
    deliverTrash.resolve();
    const trash = page.getByTestId('trash-bin-toggle').locator('..');
    await trash.getByText(threads[5].title, { exact: true }).waitFor();
    const trashItem = page
      .locator('[data-testid="trash-bin-toggle"]')
      .locator('..')
      .getByText(threads[0].title, { exact: true })
      .locator('..');
    await trashItem.getByRole('button', { name: '恢复', exact: true }).click();
    await first.waitFor();
    assert.equal(Boolean(store.get(threads[0].id).deletedAt), false);
    await first.getByRole('link', { name: threads[0].title, exact: true }).click();
    await page.getByTestId('restored-history').getByText('恢复后必须保留的历史内容', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, '02-restored-history.png') });
    await page.getByRole('button', { name: '个人设置', exact: true }).click();
    const preference = page.getByRole('switch', { name: '删除普通会话前确认', exact: true });
    await preference.waitFor();
    assert.equal(await preference.isChecked(), false);
    await preference.check();
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true',
    );
    await page.screenshot({ path: path.join(evidence, '03-preference-restored.png'), animations: 'disabled' });
    await first.hover();
    await first.getByTestId('thread-quick-delete').click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    await page.evaluate(() => window.__threadDeleteTheme('dark'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await first.hover();
    await page.screenshot({ path: path.join(evidence, '04-dark-row.png') });
    await page.setViewportSize({ width: 390, height: 900 });
    await first.getByTestId('thread-quick-delete').click();
    await dialog.waitFor();
    await page.screenshot({ path: path.join(evidence, '05-narrow-confirm.png') });
    for (const button of await dialog.getByRole('button').all()) {
      assert.equal(
        await button.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const middleX = (box.left + box.right) / 2;
          const middleY = (box.top + box.bottom) / 2;
          return [
            [middleX, middleY],
            [box.left + 2, middleY],
            [box.right - 2, middleY],
            [middleX, box.top + 2],
            [middleX, box.bottom - 2],
          ].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
        }),
        true,
        'the whole confirmation action remains reachable while deletion notifications are visible',
      );
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape');
    const storageState = await context.storageState();
    await context.close();
    const reopened = await browser.newContext({ storageState, viewport: { width: 1000, height: 800 } });
    const reloaded = await openPage(reopened);
    await reloaded.getByRole('button', { name: '个人设置', exact: true }).click();
    assert.equal(await reloaded.getByRole('switch', { name: '删除普通会话前确认', exact: true }).isChecked(), true);
    await reopened.close();
    assert.deepEqual(errors, []);
    writeFileSync(
      path.join(evidence, 'journey-result.json'),
      JSON.stringify(
        {
          result: 'PASS',
          productionThreadRoutes: true,
          productionSidebarAndSettings: true,
          identityChangeCancelsDraft: true,
          windowsInstaller: 'NOT_RUN',
          requests,
          history: messages.getByThread(threads[0].id).map((message) => message.content),
        },
        null,
        2,
      ),
    );
  },
);

['refresh-owner-change', 'refresh-same-owner', '401-owner-change'].forEach((scenario) => {
  test(`identity-bound deletion across ${scenario}`, { timeout: 60_000 }, async (t) => {
    proof.setSessionOwner(owner);
    const target = store.create(owner, `身份边界 ${scenario}`);
    const context = await browser.newContext({ viewport: { width: 1228, height: 900 } });
    t.after(async () => context.close());
    await context.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
    const page = await openPage(context, `/thread/${target.id}`);
    const row = page.locator(`[data-thread-id="${target.id}"]`);
    await row.getByTestId('thread-quick-delete').click();
    const dialog = page.getByRole('dialog', { name: '确认删除对话' });
    await dialog.getByRole('checkbox').check();
    const captured = Promise.withResolvers(),
      release = Promise.withResolvers();
    proof.delayResponse('/api/session', { captured: captured.resolve, released: release.promise });
    if (scenario === '401-owner-change') {
      proof.failNextDelete(401, 'thread-delete-new-session-owner');
    } else {
      proof.setSessionOwner(scenario === 'refresh-same-owner' ? owner : 'thread-delete-new-session-owner');
      await page.evaluate(() => {
        window.__threadDeletePendingRefresh = window.__threadDeleteRefreshSession();
      });
      await captured.promise;
    }
    await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    if (scenario === '401-owner-change') await captured.promise;
    const delivered = page.waitForResponse((response) => response.url().endsWith('/api/session'));
    release.resolve();
    await delivered;
    if (scenario !== '401-owner-change') await page.evaluate(() => window.__threadDeletePendingRefresh);
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-thread-id="${id}"] [data-testid="thread-quick-delete"]`)?.disabled,
      target.id,
    );
    const deletes = requests.filter((request) => request.method === 'DELETE' && request.url.endsWith(target.id));
    writeFileSync(
      path.join(evidence, `${scenario}.json`),
      JSON.stringify({ deletes, deletedAt: store.get(target.id).deletedAt, errors }, null, 2),
    );
    if (scenario === 'refresh-same-owner') {
      assert.equal(deletes.length, 1);
      assert.equal(deletes[0].actor, owner);
      assert.ok(store.get(target.id).deletedAt);
    } else {
      assert.equal(deletes.length, scenario === '401-owner-change' ? 1 : 0);
      assert.equal(
        deletes.some((request) => request.actor !== owner),
        false,
      );
      assert.equal(Boolean(store.get(target.id).deletedAt), false);
      assert.equal(
        await page.evaluate(() =>
          Object.keys(localStorage).some(
            (key) => key.startsWith('clowder:thread-delete-confirm:') && localStorage.getItem(key) === 'off',
          ),
        ),
        false,
      );
    }
    assert.deepEqual(errors, []);
  });
});
