import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { installMentionPreferences } from './f322-mention-personal-owner.mjs';

/** Real message owner and decision routes behind the real shell/mailbox. Browser transport alone is isolated. */
export function registerUserMentionJourney({ test, openProof, closeProof }) {
  test('explicit F320 mention → one mailbox row → replacement → human reply / personal ignore → closed', async () => {
    const require = createRequire(new URL('../../../api/package.json', import.meta.url));
    const Fastify = require('fastify');
    // The canonical browser command is plain Node. Load real TS owners without
    // requiring a CLI loader, and release the temporary hook even if an import fails.
    const { register } = require('tsx/esm/api');
    const unregister = register();
    const [{ MessageStore }, { companionDecisionRoutes }, { InMemoryRuntimeInteractionStore }] = await Promise.all([
      import('../../../api/src/domains/cats/services/stores/ports/MessageStore.ts'),
      import('../../../api/src/routes/companion-decision-routes.ts'),
      import('../../../api/src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.ts'),
    ]).finally(unregister);
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const app = Fastify();
    const messages = new MessageStore();
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = 'owner-1';
    });
    app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
    app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
    const preferences = await installMentionPreferences(app);
    await app.register(companionDecisionRoutes, {
      ownerUserId: 'owner-1',
      messageStore: messages,
      runtimeInteractionStore: new InMemoryRuntimeInteractionStore(),
      readIgnoredItemPreferences: preferences.read,
      now: () => 0,
    });
    const source = {
      userId: 'owner-1',
      from: { kind: 'agent', catId: 'codex61-sol' },
      threadId: 'thread-other',
      timestamp: 1791589825011,
      mentions: [],
      mentionsUser: false,
      // Source: thread_muwb72liovvdkrhr#0001791589825011-000158-86e3b709 (F320 #5311).
      content: '修复已合入 #5311，版本 8460f8424f，21 项检查通过。正式 runtime 尚未加载，真实登录仍待你实测。',
    };
    messages.append(source);
    const read = async (_attempt, { url }) => {
      const response = await app.inject(url.pathname + url.search);
      assert.equal(response.statusCode, 200);
      return { body: response.json() };
    };
    const proof = await openProof({
      unified: read,
      api: async ({ request, url }) => {
        if (url.pathname === '/api/cats')
          return {
            body: {
              cats: [
                {
                  id: 'opus',
                  carrier: 'cli',
                  displayName: '布偶猫',
                  color: { primary: '#7966a8', secondary: '#eeeaf8' },
                },
                {
                  id: 'glm52',
                  carrier: 'cli',
                  displayName: '狸花猫',
                  color: { primary: '#9b744f', secondary: '#f3eadf' },
                },
                {
                  id: 'codex61-sol',
                  carrier: 'cli',
                  displayName: '小太阳·砚砚',
                  color: { primary: '#b05f45', secondary: '#f3e3da' },
                },
              ],
            },
          };
        if (!url.pathname.startsWith('/api/concierge/work/mentions/') && url.pathname !== '/api/config/ignored-items')
          return null;
        const response = await app.inject({
          method: request.method(),
          url: url.pathname + url.search,
          headers: { origin: 'http://localhost' },
          ...(['POST', 'PATCH'].includes(request.method()) ? { payload: request.postDataJSON() } : {}),
        });
        return { status: response.statusCode, body: response.json() };
      },
    });
    const { page } = proof;
    const invalidate = () =>
      page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    try {
      await page.getByTestId('mailbox-button').click();
      assert.equal(await page.getByTestId('mailbox-item').count(), 0);
      const first = messages.append({
        ...source,
        mentionsUser: true,
        content: `${source.content}\n\n@co-creator\n现在可以更新并重启正式猫咖，加载这版让你继续测吗？`,
      });
      await invalidate();
      await page.getByTestId('mailbox-item-toggle').waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 1);
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      await page.getByTestId('mailbox-item-toggle').click();
      assert.equal(await page.getByTestId('mailbox-mention-content').textContent(), first.content);
      assert.equal(await page.getByTestId('mailbox-item').getAttribute('data-kind-label'), '@你');
      const replacement = messages.append({
        ...source,
        mentionsUser: true,
        timestamp: source.timestamp + 1,
        content: '@co-creator\n需要你安排重启。建议空闲时更新；今天不答会继续使用旧版本，修复尚不可实测。',
      });
      await invalidate();
      await page.getByTestId('mailbox-mention-content').filter({ hasText: '需要你安排重启' }).waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 1);
      assert.equal(await page.getByTestId('mailbox-mention-content').textContent(), replacement.content);
      if (process.env.F322_USER_MENTION_EVIDENCE_DIR) {
        mkdirSync(process.env.F322_USER_MENTION_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(process.env.F322_USER_MENTION_EVIDENCE_DIR, 'mailbox-request.png'),
          fullPage: true,
        });
      }
      // The actual original-place control navigates to the source conversation.
      await page.getByTestId('mailbox-open-original').click();
      await page.waitForURL('**/thread/thread-other');
      messages.append({
        ...source,
        from: { kind: 'user', userId: source.userId },
        timestamp: source.timestamp + 2,
        content: '可以，稍后重启',
      });
      await invalidate();
      if ((await page.getByTestId('mailbox-panel').count()) === 0) await page.getByTestId('mailbox-button').click();
      await page.getByTestId('mailbox-group-mentions').getByText('暂无 @你 请求', { exact: true }).waitFor();
      await page.getByRole('button', { name: '待办，暂无', exact: true }).waitFor();
      messages.append({ ...source, mentionsUser: true, timestamp: source.timestamp + 3, content: replacement.content });
      await invalidate();
      if ((await page.getByTestId('mailbox-panel').count()) === 0) await page.getByTestId('mailbox-button').click();
      await page.getByTestId('mailbox-item-toggle').waitFor();
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      await page.getByTestId('mailbox-item-toggle').click();
      await page.getByTestId('mailbox-item-ignore').click();
      await page.getByTestId('mailbox-group-mentions').getByText('暂无 @你 请求', { exact: true }).waitFor();
      assert.equal(preferences.read('owner-1').entries.length, 1);
      assert.equal(
        messages.listUserMentionRequests('owner-1').length,
        1,
        'personal ignore never handles the canonical request',
      );
      await page.getByRole('button', { name: '待办，暂无', exact: true }).waitFor();
      assert.equal(await page.getByTestId('mailbox-item').count(), 0);
      // More than one page: the newest request is visible immediately; valid old requests remain reachable.
      for (let index = 0; index < 25; index++)
        messages.append({
          ...source,
          threadId: `old-${index}`,
          mentionsUser: true,
          timestamp: source.timestamp + 4 + index,
          content: `@co-creator\n旧请求 ${index}`,
        });
      messages.append({
        ...source,
        threadId: 'newest',
        mentionsUser: true,
        timestamp: source.timestamp + 50,
        content: '@co-creator\n最新请求，请查看。',
      });
      await invalidate();
      if ((await page.getByTestId('mailbox-panel').count()) === 0) await page.getByTestId('mailbox-button').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-item"]').length === 20);
      assert.equal(await page.getByTestId('rail-badge-count').count(), 0);
      assert.equal(await page.getByTestId('mailbox-item').count(), 20);
      await page.getByTestId('mailbox-item-toggle').first().click();
      assert.equal(await page.getByTestId('mailbox-mention-content').textContent(), '@co-creator\n最新请求，请查看。');
      await page.getByTestId('mailbox-next-page').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-item"]').length === 6);
      assert.equal(await page.getByTestId('mailbox-next-page').isDisabled(), true);
      await page.getByTestId('mailbox-item-toggle').last().click();
      assert.equal(await page.getByTestId('mailbox-mention-content').textContent(), '@co-creator\n旧请求 0');
      if (process.env.F322_USER_MENTION_EVIDENCE_DIR)
        await page.screenshot({
          path: path.join(process.env.F322_USER_MENTION_EVIDENCE_DIR, 'mailbox-page-two.png'),
          fullPage: true,
        });
      await page.getByTestId('mailbox-previous-page').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-item"]').length === 20);
      assert.equal(await page.getByTestId('mailbox-previous-page').isDisabled(), true);
    } finally {
      await closeProof(proof);
      await app.close();
      await preferences.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });
}
