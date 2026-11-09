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

async function requestDelete(row) {
  await row.hover();
  await row.getByRole('button', { name: '更多操作', exact: true }).click();
  await row.getByRole('menuitem', { name: '删除对话', exact: true }).click();
}

test(
  'menu-only deletion always confirms and restores original history through the production API',
  { timeout: 120_000 },
  async (t) => {
    proof.setSessionOwner(owner);
    const context = await browser.newContext({ viewport: { width: 1228, height: 900 } });
    t.after(async () => context.close());
    await context.addInitScript(
      ({ origin, owner }) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem(
          `clowder:thread-delete-confirm:v1:${encodeURIComponent(origin)}:${encodeURIComponent(owner)}`,
          'off',
        );
      },
      { origin, owner },
    );
    const page = await openPage(context, `/thread/${threads[0].id}`);
    const first = page.locator(`[data-thread-id="${threads[0].id}"]`);
    await first.hover();
    assert.equal(await page.getByTestId('thread-quick-delete').count(), 0);
    await page.screenshot({ path: path.join(evidence, '00-menu-only-row.png') });
    await requestDelete(first);
    const dialog = page.getByRole('dialog', { name: '确认删除对话' });
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 0);
    await requestDelete(first);
    proof.setSessionOwner('thread-delete-other-owner');
    await page.evaluate(() => window.__threadDeleteRefreshSession());
    await dialog.waitFor({ state: 'detached' });
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 0);
    proof.setSessionOwner(owner);
    await page.evaluate(() => window.__threadDeleteRefreshSession());
    await requestDelete(first);
    await page.screenshot({ path: path.join(evidence, '01-mandatory-confirm.png') });
    await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
    await first.waitFor({ state: 'detached' });
    await page.waitForURL(origin + '/');
    assert.ok(store.get(threads[0].id).deletedAt);
    await page.reload();
    const second = page.locator(`[data-thread-id="${threads[1].id}"]`);
    const third = page.locator(`[data-thread-id="${threads[4].id}"]`);
    const captured = Promise.withResolvers(),
      deliver = Promise.withResolvers();
    proof.delayResponse('/api/threads?view=sidebar', { captured: captured.resolve, released: deliver.promise });
    await requestDelete(second);
    assert.equal(
      requests.filter((request) => request.method === 'DELETE').length,
      1,
      'old off cannot bypass confirmation',
    );
    await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
    await captured.promise;
    await requestDelete(third);
    await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === 'DELETE' && response.url().endsWith(threads[4].id),
      ),
      dialog.getByRole('button', { name: '移入回收站', exact: true }).click(),
    ]);
    assert.ok(store.get(threads[4].id).deletedAt);
    deliver.resolve();
    await second.waitFor({ state: 'detached' });
    await third.waitFor({ state: 'detached' });
    const busy = page.locator(`[data-thread-id="${threads[2].id}"]`);
    await requestDelete(busy);
    await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
    await page.getByText('猫猫正在工作中，请等待当前任务完成后再删除对话。', { exact: true }).waitFor();
    assert.equal(Boolean(store.get(threads[2].id).deletedAt), false);
    const capturedTrash = Promise.withResolvers(),
      deliverTrash = Promise.withResolvers();
    proof.delayResponse('/api/threads?deleted=true', {
      captured: capturedTrash.resolve,
      released: deliverTrash.promise,
    });
    await page.getByTestId('trash-bin-toggle').click();
    await capturedTrash.promise;
    const refreshTarget = page.locator(`[data-thread-id="${threads[5].id}"]`);
    await requestDelete(refreshTarget);
    await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === 'DELETE' && response.url().endsWith(threads[5].id),
      ),
      dialog.getByRole('button', { name: '移入回收站', exact: true }).click(),
    ]);
    await refreshTarget.waitFor({ state: 'detached' });
    deliverTrash.resolve();
    const trash = page.getByTestId('trash-bin-toggle').locator('..');
    await trash.getByText(threads[5].title, { exact: true }).waitFor();
    await trash
      .getByText(threads[0].title, { exact: true })
      .locator('..')
      .getByRole('button', { name: '恢复', exact: true })
      .click();
    await first.waitFor();
    assert.equal(Boolean(store.get(threads[0].id).deletedAt), false);
    await first.getByRole('link', { name: threads[0].title, exact: true }).click();
    await page.getByTestId('restored-history').getByText('恢复后必须保留的历史内容', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, '02-restored-history.png') });
    await page.getByRole('button', { name: '个人设置', exact: true }).click();
    await page.getByTestId('you-settings-page').waitFor();
    assert.equal(await page.getByRole('switch', { name: '删除普通会话前确认', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidence, '03-settings-without-bypass.png') });
    await requestDelete(first);
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    await page.evaluate(() => window.__threadDeleteTheme('dark'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await first.hover();
    await page.screenshot({ path: path.join(evidence, '04-dark-row.png') });
    await page.setViewportSize({ width: 390, height: 900 });
    await requestDelete(first);
    await dialog.waitFor();
    await page.screenshot({ path: path.join(evidence, '05-narrow-confirm.png') });
    for (const button of await dialog.getByRole('button').all()) {
      assert.equal(
        await button.evaluate((element) => {
          const r = element.getBoundingClientRect();
          const x = (r.left + r.right) / 2,
            y = (r.top + r.bottom) / 2;
          return [
            [x, y],
            [r.left + 2, y],
            [r.right - 2, y],
            [x, r.top + 2],
            [x, r.bottom - 2],
          ].every(([px, py]) => element.contains(document.elementFromPoint(px, py)));
        }),
        true,
        'confirmation controls remain reachable above notifications',
      );
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    writeFileSync(
      path.join(evidence, 'journey-result.json'),
      JSON.stringify(
        {
          result: 'PASS',
          productionThreadRoutes: true,
          menuOnly: true,
          oldOffCannotBypassConfirmation: true,
          identityChangeCancelsDraft: true,
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
    await requestDelete(row);
    const dialog = page.getByRole('dialog', { name: '确认删除对话' });
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
      (id) => !document.querySelector(`[data-thread-id="${id}"] [aria-label="更多操作"]`)?.disabled,
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
