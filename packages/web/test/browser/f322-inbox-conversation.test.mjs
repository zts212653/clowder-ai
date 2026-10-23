import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxConversationFixture } from './f322-inbox-conversation.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const root = process.env.F322_CONVERSATION_EVIDENCE ?? (await mkdtemp(path.join(os.tmpdir(), 'f322-conversation-')));
if (!process.env.F322_CONVERSATION_EVIDENCE) after(() => rm(root, { recursive: true, force: true }));

async function assertPublicChoiceVisible(label) {
  assert.equal(
    await label.evaluate((element) => {
      const node = element.firstChild;
      if (node?.nodeType !== Node.TEXT_NODE) return false;
      const start = node.textContent.indexOf('Alpha');
      if (start < 0) return false;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'Alpha'.length);
      const choice = range.getBoundingClientRect(),
        label = element.getBoundingClientRect();
      return choice.left >= label.left && choice.right <= label.right + 1;
    }),
    true,
    'The actual public choice must be visible before the result label is truncated',
  );
}

for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(`F322 canonical Chat and Inbox conversation answers ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(root, `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const f = await createInboxConversationFixture(language);
      t.after(() => f.close());
      const chat = await f.create('chat-button'),
        inbox = await f.create('inbox-text');
      const port = await availablePort();
      const env = await createNextDevTestEnvironment(`f322-conversation-${language}-${width}`, {
        API_SERVER_PORT: String(f.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${f.apiPort}`,
        FRONTEND_PORT: String(port),
      });
      t.after(() => env.cleanup());
      const server = spawn(
        process.execPath,
        [
          path.join(web, 'scripts/sync-vendor-assets.mjs'),
          '--watch',
          '--',
          process.execPath,
          path.join(tree, 'node_modules/next/dist/bin/next'),
          'dev',
          '-H',
          '127.0.0.1',
          '-p',
          String(port),
        ],
        { cwd: web, env: env.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      t.after(() => stopChild(server));
      for (const s of [server.stdout, server.stderr])
        s.on('data', (d) => writeFile(path.join(evidence, 'web.log'), d, { flag: 'a' }));
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/thread/${f.conversationThread.id}`, server);
      const browser = await chromium.launch({ headless: true });
      let page;
      const errors = [],
        posts = [];
      t.after(async () => {
        try {
          if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
            await writeFile(
              path.join(evidence, 'final-state.json'),
              JSON.stringify(
                {
                  text: await page.locator('body').innerText(),
                  errors,
                  posts,
                  mutations: f.mutations,
                  reads: f.reads,
                  canonical: await Promise.all([
                    f.store.get(chat.request.interactionId),
                    f.store.get(inbox.request.interactionId),
                  ]),
                  messages: f.messages.getByThreadIncludingQueued(f.conversationThread.id, 100, 'default-user'),
                  queue: f.queue.list(f.conversationThread.id, 'default-user'),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          await browser.close();
        }
      });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/runtime-interactions\/[^/]+\/respond$/.test(new URL(request.url()).pathname)
        )
          posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
      });
      await page.addInitScript((language) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
      }, language);
      await page.goto(`${base}/thread/${f.conversationThread.id}?shell=v2`);
      const original = page.locator(
        `[data-rich-block-id="${chat.cardRef.blockId}"] [data-testid="runtime-conversation-card"]`,
      );
      await original.getByRole('button', { name: 'Alpha', exact: true }).click();
      await page.screenshot({ path: path.join(evidence, 'chat-before.png'), fullPage: true });
      await original
        .getByRole('button', { name: language === 'en' ? 'Confirm selection' : '确认选择', exact: true })
        .click();
      await original.getByTestId('conversation-decision-result').waitFor();
      const chatAfter = await f.store.get(chat.request.interactionId);
      assert.equal(chatAfter.status, 'answered');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.expectedRevision, chat.revision);
      assert.deepEqual(posts[0].body.cardRef, chat.cardRef);
      const chatReturns = f.messages
        .getByThreadIncludingQueued(f.conversationThread.id, 100, 'default-user')
        .filter((m) => m.replyTo === chat.cardRef.messageId);
      assert.equal(chatReturns.length, 1, 'Exactly one canonical return message, including queued custody');
      assert.equal(chatReturns[0].id, chatAfter.terminal.responseMessageId);
      assert.equal(chatReturns[0].extra.runtimeInteractionReturn.operationId, posts[0].body.operationId);
      await page.screenshot({ path: path.join(evidence, 'chat-settled.png'), fullPage: true });
      await page.getByTestId('mailbox-button').click();
      const row = page.getByTestId('mailbox-item').filter({ hasText: inbox.request.title });
      const bound = row.getByTestId('runtime-conversation-card');
      await bound
        .getByRole('button', { name: language === 'en' ? 'Answer in text' : '用文字回答', exact: true })
        .waitFor();
      await bound.scrollIntoViewIfNeeded();
      await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      const inboxRender = await row.evaluate((element) => ({
        text: element.innerText,
        bounds: element.getBoundingClientRect().toJSON(),
        expanded: element.getAttribute('data-expanded'),
        group: element.closest('section[data-testid^="mailbox-group-"]')?.getAttribute('data-testid'),
      }));
      assert.equal(inboxRender.group, 'mailbox-group-decisions', 'Explicit waiting stays with canonical decisions');
      assert.equal(inboxRender.expanded, 'false', 'Original conversation controls remain on the first layer');
      assert.ok(inboxRender.bounds.left >= 0 && inboxRender.bounds.right <= width + 1);
      assert.ok(!inboxRender.text.includes('default-user'));
      await writeFile(path.join(evidence, 'inbox-render.json'), JSON.stringify(inboxRender, null, 2));
      await page.screenshot({ path: path.join(evidence, 'inbox-before.png'), fullPage: true });
      await bound
        .getByRole('button', { name: language === 'en' ? 'Answer in text' : '用文字回答', exact: true })
        .click();
      await page.waitForURL((url) => url.pathname === `/thread/${f.conversationThread.id}`);
      const close = page.getByTestId('mailbox-close');
      if (await close.isVisible()) await close.click();
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
      await draft.fill('Use Alpha for this verification.');
      await draft.press('Enter');
      const target = page.locator(
        `[data-rich-block-id="${inbox.cardRef.blockId}"] [data-testid="runtime-conversation-card"]`,
      );
      await target.getByTestId('conversation-decision-result').waitFor();
      const textAfter = await f.store.get(inbox.request.interactionId);
      assert.equal(textAfter.status, 'answered');
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1].body.response, { kind: 'text', text: 'Use Alpha for this verification.' });
      assert.equal(posts[1].body.expectedRevision, inbox.revision);
      assert.deepEqual(posts[1].body.cardRef, inbox.cardRef);
      assert.equal(await draft.inputValue(), '');
      const returns = f.messages
        .getByThreadIncludingQueued(f.conversationThread.id, 100, 'default-user')
        .filter((m) => m.replyTo === inbox.cardRef.messageId);
      assert.equal(returns.length, 1);
      assert.equal(returns[0].id, textAfter.terminal.responseMessageId);
      assert.equal(returns[0].extra.runtimeInteractionReturn.operationId, posts[1].body.operationId);
      assert.equal(returns[0].content, 'Use Alpha for this verification.');
      const queued = f.queue.list(f.conversationThread.id, 'default-user');
      assert.equal(queued.length, 2);
      for (const entry of queued) {
        assert.equal(entry.kind, 'message_wake');
        assert.deepEqual(entry.owner, { kind: 'user', userId: 'default-user' });
        assert.deepEqual(entry.from, { kind: 'user', userId: 'default-user' });
        assert.deepEqual(entry.targets, ['codex61-sol']);
        assert.equal(entry.payload.sourceRecordId, entry.payload.messageId);
      }
      assert.deepEqual(
        queued.map((entry) => entry.payload.messageId).sort(),
        [chatAfter.terminal.responseMessageId, textAfter.terminal.responseMessageId].sort(),
      );
      const defaulted = await f.create('default-choice', {
        deadlineAt: Date.now() + 100,
        defaultResponse: { kind: 'selection', selectedIds: ['alpha'] },
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await f.service.reconcileConversationDeadlines();
      const defaultTerminal = await f.store.get(defaulted.request.interactionId);
      assert.equal(defaultTerminal.terminal.reasonCode, 'defaulted');
      assert.deepEqual(defaultTerminal.terminal.response.selectedIds, ['alpha']);
      await page.reload();
      await target.getByTestId('conversation-decision-result').waitFor();
      await original.getByTestId('conversation-decision-result').waitFor();
      await page.screenshot({ path: path.join(evidence, 'text-settled-after-refresh.png'), fullPage: true });
      const defaultChat = page
        .locator(`[data-rich-block-id="${defaulted.cardRef.blockId}"]`)
        .getByTestId('decision-result-row');
      await defaultChat.getByTestId('decision-result-label').waitFor();
      assert.match(await defaultChat.getByTestId('decision-result-label').innerText(), /Alpha/);
      assert.equal(await defaultChat.getByTestId('decision-result-dot').getAttribute('data-status'), 'closed');
      await assertPublicChoiceVisible(defaultChat.getByTestId('decision-result-label'));
      await defaultChat.screenshot({ path: path.join(evidence, 'default-chat-collapsed.png') });
      await page.getByTestId('mailbox-button').click();
      await row.waitFor({ state: 'detached' });
      for (const entry of [chat, inbox, defaulted]) {
        const receipt = page.locator(
          `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify(['F306', entry.request.interactionId])}']`,
        );
        await receipt.getByTestId('decision-result-label').waitFor();
        if (entry === chat) assert.match(await receipt.getByTestId('decision-result-label').innerText(), /Alpha/);
        if (entry === defaulted) {
          assert.match(await receipt.getByTestId('decision-result-label').innerText(), /Alpha/);
          assert.equal(await receipt.getByTestId('decision-result-dot').getAttribute('data-status'), 'closed');
          await assertPublicChoiceVisible(receipt.getByTestId('decision-result-label'));
        }
        assert.equal(await receipt.getByTestId('decision-result-details').count(), 0);
        await receipt.locator('button[aria-expanded="false"]').click();
        await receipt.getByTestId('decision-result-details').waitFor();
        assert.equal(await receipt.locator('input, select, textarea, form').count(), 0);
        await receipt.screenshot({ path: path.join(evidence, `${entry.request.interactionId}-retained.png`) });
      }
      assert.equal((await f.store.readPendingIndexByUser('default-user')).records.length, 0);
      assert.equal(f.mutations.filter((m) => m.path.includes('block-state')).length, 0);
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            chat,
            inbox,
            chatAfter,
            textAfter,
            defaultTerminal,
            posts,
            returnMessages: f.messages
              .getByThreadIncludingQueued(f.conversationThread.id, 100, 'default-user')
              .filter((m) => m.replyTo === chat.cardRef.messageId || m.replyTo === inbox.cardRef.messageId),
            queue: f.queue.list(f.conversationThread.id, 'default-user'),
            sourceReads: f.reads,
            errors,
            boundary:
              'Real Next ChatMessage/RichBlocks/InteractiveBlock, Inbox and ChatInput; original private owner session/Message/runtime store/HTTP CAS/Queue return. Trusted fixture creation, no live provider or Redis durability claim; not whole17/Alpha/runtime.',
          },
          null,
          2,
        ),
      );
    });

for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(
      `F322 original provider approval/question/elicitation ${language} ${width}`,
      { timeout: 240000 },
      async (t) => {
        const { verifyProviderCards } = await import('./f322-inbox-provider.journey.mjs');
        await verifyProviderCards({ t, language, width, root });
      },
    );
