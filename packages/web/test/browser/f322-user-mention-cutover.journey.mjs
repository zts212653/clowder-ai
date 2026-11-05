import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { installMentionPreferences } from './f322-mention-personal-owner.mjs';

/** The mailbox consumer and real owner writers; only the browser transport is isolated. */
export function registerMentionCutoverJourney({ test, openProof, closeProof }) {
  test('558 historical requests → personal bulk ignore/recovery → canonical 559 history → remaining 558 undo', async () => {
    const require = createRequire(new URL('../../../api/package.json', import.meta.url));
    const Fastify = require('fastify');
    // Keep the real TS owners runnable under the canonical plain-Node command.
    const { register } = require('tsx/esm/api');
    const unregister = register();
    const [{ MessageStore }, { companionDecisionRoutes }, { InMemoryRuntimeInteractionStore }] = await Promise.all([
      import('../../../api/src/domains/cats/services/stores/ports/MessageStore.ts'),
      import('../../../api/src/routes/companion-decision-routes.ts'),
      import('../../../api/src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.ts'),
    ]).finally(unregister);
    const previous = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const app = Fastify();
    const messages = new MessageStore();
    const now = Date.now();
    const source = {
      userId: 'owner-1',
      from: { kind: 'agent', catId: 'codex61-sol' },
      threadId: 'f320',
      content: '@co-creator\n需要你重启。建议空闲时更新；今天不答会继续运行旧版。',
      mentions: [],
      mentionsUser: true,
      timestamp: now + 1,
    };
    for (let n = 0; n < 558; n++)
      messages.append({ ...source, threadId: `legacy-${n}`, timestamp: now - 25 * 86400000 });
    app.addHook('preHandler', async (r) => {
      r.sessionUserId = 'owner-1';
    });
    app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
    app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
    const preferences = await installMentionPreferences(app);
    await app.register(companionDecisionRoutes, {
      ownerUserId: 'owner-1',
      messageStore: messages,
      runtimeInteractionStore: new InMemoryRuntimeInteractionStore(),
      readIgnoredItemPreferences: preferences.read,
      now: () => now,
      threadStore: {
        get: (id) => ({ createdBy: 'owner-1', title: id === 'f320' ? 'F320 登录修复' : `磁盘清理 · 旧请求 ${id}` }),
      },
    });
    const proof = await openProof({
      viewport: { width: 1024, height: 820 },
      unified: async (_a, { url }) => {
        const r = await app.inject(url.pathname + url.search);
        return { status: r.statusCode, body: r.json() };
      },
      api: async ({ request, url }) => {
        if (url.pathname === '/api/approval-hub/settled') return { body: { items: [] } };
        if (!url.pathname.startsWith('/api/concierge/work/mentions/') && url.pathname !== '/api/config/ignored-items')
          return null;
        const r = await app.inject({
          method: request.method(),
          url: url.pathname + url.search,
          headers: { origin: 'http://localhost' },
          ...(['POST', 'PATCH'].includes(request.method()) ? { payload: request.postDataJSON() } : {}),
        });
        return { status: r.statusCode, body: r.json() };
      },
    });
    const { page } = proof;
    const invalidate = () => page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:user-mention-updated')));
    try {
      await page.getByTestId('mailbox-button').click();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.equal(await page.getByTestId('mailbox-item').count(), 0);
      assert.equal(await page.getByRole('combobox', { name: '请求时间筛选' }).inputValue(), 'week');
      messages.append(source);
      await invalidate();
      await page.getByTestId('mailbox-item-toggle').filter({ hasText: 'F320 登录修复' }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.match(await page.getByTestId('mailbox-item-toggle').innerText(), /F320 登录修复/);
      assert.match(await page.getByTestId('mailbox-mention-preview').innerText(), /需要你重启/);
      assert.doesNotMatch(await page.getByTestId('mailbox-item-toggle').innerText(), /有事找你/);
      const out = process.env.F322_USER_MENTION_EVIDENCE_DIR;
      if (out) {
        mkdirSync(out, { recursive: true });
        await page.screenshot({ path: path.join(out, 'cutover-recent.png'), fullPage: true });
      }
      await page.getByRole('combobox', { name: '请求时间筛选' }).selectOption('earlier');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-item"]').length === 20);
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      await page.getByTestId('mailbox-next-page').click();
      await page.getByText('第 2 页', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      await page.getByTestId('mailbox-mentions-ignore-all').click();
      await page.getByRole('alertdialog').waitFor();
      assert.match(await page.getByRole('alertdialog').innerText(), /558/);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(preferences.read('owner-1').entries.length, 0, 'cancel has no preference side effect');
      await page.getByTestId('mailbox-mentions-ignore-all').click();
      const primary = page.getByTestId('mailbox-mentions-ignore-confirm');
      assert.notEqual(await primary.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
      await primary.click();
      await page.getByTestId('mailbox-group-mentions').getByText('暂无 @你 请求', { exact: true }).waitFor();
      const saved = preferences.read('owner-1');
      assert.equal(saved.entries.length, 558, 'the complete period, not either visible page, is persisted');
      assert.equal(new Set(saved.entries.map((entry) => entry.coordinate.decisionRef)).size, 558);
      assert.equal(messages.listUserMentionRequests('owner-1').length, 559);
      assert.equal(proof.requests.filter((r) => r.startsWith('POST /api/concierge/work/mentions/')).length, 0);
      await page.reload();
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('mailbox-item-toggle').filter({ hasText: 'F320 登录修复' }).waitFor();
      assert.deepEqual(preferences.read('owner-1'), saved, 'reload keeps every persisted ignored version');
      await page.getByTestId('mailbox-open-ignored').click();
      await page.getByTestId('mailbox-period-earlier').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-item"]').length === 20);
      await page.getByTestId('mailbox-next-page').click();
      await page.getByText('第 2 页', { exact: true }).waitFor();
      const restoredRow = page.getByTestId('mailbox-item').first();
      const restoredKey = await restoredRow.getAttribute('data-row-key');
      const restoredEntry = saved.entries.find((entry) => restoredKey.includes(entry.coordinate.decisionRef));
      assert.ok(restoredEntry);
      await restoredRow.getByTestId('mailbox-item-toggle').click();
      await restoredRow.getByTestId('mailbox-item-restore').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="mailbox-state-text"]')?.textContent === '当前范围共 557 件',
      );
      const personalAfterRestore = preferences.read('owner-1');
      assert.deepEqual(
        personalAfterRestore.entries,
        saved.entries.filter((entry) => entry !== restoredEntry),
      );
      assert.equal(messages.listUserMentionRequests('owner-1').length, 559);
      await page.getByTestId('mailbox-handled-back').click();

      // The two old bulk-handled front doors retired in v3. Seed an authentic
      // legacy batch through its original owner, then exercise every surviving
      // history/pagination/individual-restore/remaining-batch-undo browser path.
      const handled = await app.inject({
        method: 'POST',
        url: '/api/concierge/work/mentions/handle',
        headers: { origin: 'http://localhost' },
        payload: {
          requests: messages
            .listUserMentionRequests('owner-1')
            .map((message) => ({ threadId: message.threadId, messageId: message.id })),
        },
      });
      assert.equal(handled.statusCode, 200);
      await invalidate();
      await page.getByTestId('mailbox-group-mentions').getByText('暂无 @你 请求', { exact: true }).waitFor();
      assert.equal(messages.listUserMentionRequests('owner-1').length, 0);
      if (out) await page.screenshot({ path: path.join(out, 'cutover-handled-undo.png'), fullPage: true });
      await page.getByTestId('mailbox-history').click();
      await page.getByTestId('mailbox-title').filter({ hasText: '已处理的 @你' }).waitFor();
      await page.getByTestId('mailbox-state-text').filter({ hasText: '559' }).waitFor();
      await page.getByTestId('mailbox-mentions-undo').waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 20);
      assert.equal(await page.getByText('类型', { exact: true }).count(), 0);
      await page.getByTestId('mailbox-next-page').click();
      await page.getByText('第 2 页', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 20);
      await page.getByTestId('mailbox-previous-page').click();
      await page.getByText('第 1 页', { exact: true }).waitFor();
      if (out) await page.screenshot({ path: path.join(out, 'cutover-history.png'), fullPage: true });
      await page.getByTestId('mailbox-item-toggle').filter({ hasText: 'F320 登录修复' }).click();
      await page.getByTestId('mailbox-mention-restore').click();
      await page.getByTestId('mailbox-mentions-undo').filter({ hasText: '剩 558 件' }).waitFor();
      await page.getByTestId('mailbox-handled-back').click();
      await page.reload();
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('mailbox-history').click();
      await page.getByTestId('mailbox-mentions-undo').filter({ hasText: '剩 558 件' }).waitFor();
      await page.getByTestId('mailbox-mentions-undo').click();
      await page.getByRole('status').filter({ hasText: '已撤销 558 件' }).waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.equal(messages.listUserMentionRequests('owner-1').length, 559);
      assert.deepEqual(
        preferences.read('owner-1'),
        personalAfterRestore,
        'canonical undo leaves all personal preferences unchanged',
      );
      assert.equal(await page.getByTestId('mailbox-mentions-undo').count(), 0);
      assert.equal(await page.getByText('已处理 559 件 @你 请求。', { exact: true }).count(), 0);
      await page.getByTestId('mailbox-handled-back').click();
      await page.getByRole('combobox', { name: '请求时间筛选' }).selectOption('earlier');
      // Canonical restore advances each request revision. Personal ignores are
      // exact-version preferences, so they must not hide these new revisions.
      await page.getByTestId('mailbox-state-text').filter({ hasText: '当前范围共 558 件' }).waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 20);
      const visible = await app.inject(
        '/api/concierge/work/decisions?view=unified&includeUserMentions=true&personalView=visible&mentionPeriod=earlier&limit=20',
      );
      assert.equal(visible.statusCode, 200);
      const currentCoordinates = visible.json().items.map((item) => item.preferenceCoordinate);
      assert.equal(currentCoordinates.length, 20);
      for (const coordinate of currentCoordinates) {
        const old = saved.entries.find((entry) => entry.coordinate.decisionRef === coordinate.decisionRef);
        assert.ok(old);
        assert.notEqual(coordinate.version, old.coordinate.version);
      }
    } finally {
      await closeProof(proof);
      await app.close();
      await preferences.close();
      if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previous;
    }
  });
}
