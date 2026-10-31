import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxMemoryCorrectionFixture } from './f322-inbox-memory-correction.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const evidenceRoot = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-memory-correction');
async function freeze(page, card) {
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function decide(page, card, record, word, responses, expectedStatus = 200) {
  const button = card.getByRole('button', { name: word, exact: true });
  await button.waitFor();
  await page.waitForFunction((el) => !el.disabled, await button.elementHandle());
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname ===
        `/api/event-memory-corrections/${record.proposalId}/${record.verb === 'reject' ? 'reject' : 'approve'}` &&
      r.request().method() === 'POST',
  );
  await button.focus();
  await page.keyboard.press('Enter');
  const response = await pending,
    body = await response.json();
  responses.push({ path: new URL(response.url()).pathname, status: response.status(), body });
  assert.equal(response.status(), expectedStatus, JSON.stringify(body));
  if (expectedStatus === 200) assert.equal(body.status, record.verb === 'reject' ? 'rejected' : 'approved');
}
for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(`F322 original memory correction Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(evidenceRoot, 'memory-correction', `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const f = await createInboxMemoryCorrectionFixture(language, { withRecovery: true }),
        source = f.approvalSources;
      const approved = source.records.find((r) => r.verb === 'approve'),
        rejected = source.records.find((r) => r.verb === 'reject');
      let env, server, browser, page;
      const errors = [],
        responses = [],
        decisions = [],
        render = [];
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
                  responses,
                  decisions,
                  mutations: f.mutations,
                  reads: f.reads,
                  effects: await source.effects(),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          const results = await Promise.allSettled([
            browser?.close(),
            server ? stopChild(server) : undefined,
            env?.cleanup(),
            f.close(),
          ]);
          const failures = results.filter((r) => r.status === 'rejected');
          if (failures.length)
            throw new AggregateError(
              failures.map((r) => r.reason),
              'Owned memory correction journey cleanup failed',
            );
        }
      });
      const port = await availablePort();
      env = await createNextDevTestEnvironment(`f322-correction-${language}-${width}`, {
        API_SERVER_PORT: String(f.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${f.apiPort}`,
        FRONTEND_PORT: String(port),
      });
      server = spawn(
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
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/thread/${rejected.thread.id}`, server);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /^\/api\/event-memory-corrections\/[^/]+\/(approve|reject)$/.test(new URL(request.url()).pathname)
        )
          decisions.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
      });
      await page.addInitScript((lang) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', lang);
      }, language);
      await page.goto(`${base}/thread/${rejected.thread.id}?shell=v2`);
      const chat = page.locator(`[data-rich-block-id="${rejected.block.id}"]`);
      const rejectWord = language === 'en' ? 'Reject this suggestion' : '拒绝这条建议';
      await chat.getByRole('button', { name: rejectWord, exact: true }).waitFor();
      await freeze(page, chat);
      const chatText = await chat.innerText();
      assert.match(chatText, language === 'en' ? /New information became available/ : /后来有了新情况/);
      assert.ok(
        !chatText.includes('outdated') && !chatText.includes(rejected.eventId) && !chatText.includes('default-user'),
      );
      render.push({ entrance: 'Chat', text: chatText, box: await chat.boundingBox() });
      await page.screenshot({ path: path.join(evidence, 'chat-before.png'), fullPage: true });
      await decide(page, chat, rejected, rejectWord, responses);
      await chat.getByTestId('decision-result-label').waitFor();
      await chat.locator('button[aria-expanded="false"]').click();
      await chat.getByTestId('memory-correction-chat-result').waitFor();
      await freeze(page, chat);
      assert.match(await chat.innerText(), language === 'en' ? /Rejected.*You/ : /已拒绝.*你/);
      await page.screenshot({ path: path.join(evidence, 'chat-result.png'), fullPage: true });
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea'),
        draftText = 'Preserved original correction draft';
      await draft.fill(draftText);
      await page.getByTestId('mailbox-button').click();
      const card = page.getByTestId(`memory-correction-${approved.proposalId}`);
      await card.waitFor();
      await freeze(page, card);
      const row = card.locator('xpath=ancestor::li');
      assert.equal(await row.getAttribute('data-expanded'), 'false');
      const text = await card.innerText();
      assert.match(text, language === 'en' ? /Memory correction/ : /记忆纠错/);
      assert.ok(!text.includes(approved.eventId) && !text.includes('outdated') && !text.includes('default-user'));
      assert.equal(await row.getByTestId('mailbox-item-toggle').count(), 0);
      const disclosure = card.locator('details');
      assert.equal(await disclosure.getAttribute('open'), null);
      render.push({ entrance: 'Inbox', text, box: await card.boundingBox() });
      await page.screenshot({ path: path.join(evidence, 'inbox-closed.png'), fullPage: true });
      await disclosure.locator('summary').click();
      const region = disclosure.getByRole('region');
      assert.match(
        await region.innerText(),
        language === 'en' ? /The original explanation.*The corrected explanation/s : /原来的解释.*核实后的解释/s,
      );
      assert.equal(await region.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 260), true);
      await region.focus();
      await page.keyboard.press('PageDown');
      await page.waitForFunction((el) => el.scrollTop > 0, await region.elementHandle());
      await freeze(page, card);
      await page.screenshot({ path: path.join(evidence, 'inbox-open.png'), fullPage: true });
      await decide(page, card, approved, language === 'en' ? 'Accept this suggestion' : '接受这条建议', responses);
      const result = page
        .getByTestId('mailbox-retained-result')
        .filter({ hasText: language === 'en' ? 'Memory correction' : '记忆纠错' });
      await result.waitFor();
      await page.waitForFunction(({ element, word }) => element.textContent.includes(word), {
        element: await result.elementHandle(),
        word: language === 'en' ? 'Original memory corrected' : '原记忆已更正',
      });
      await freeze(page, result);
      const resultText = await result.innerText();
      assert.ok(!resultText.includes('default-user') && !resultText.includes(approved.eventId));
      assert.match(resultText, language === 'en' ? /You/ : /你/);
      await page.screenshot({ path: path.join(evidence, 'inbox-result.png'), fullPage: true });
      let effects = await source.effects();
      const applied = effects.find((r) => r.verb === 'approve'),
        refused = effects.find((r) => r.verb === 'reject');
      assert.equal(applied.proposal.status, 'approved');
      assert.equal(applied.event.summary, applied.proposal.suggestedPatch.summary);
      assert.equal(eventRevision(applied), applied.proposal.appliedRevision);
      assert.ok(applied.evidence);
      assert.equal(refused.proposal.status, 'rejected');
      assert.equal(refused.event.summary, rejected.previous.summary);
      assert.equal(refused.evidence, null);
      assert.equal(decisions.length, 2);
      assert.equal(responses.length, 2);
      await page.getByTestId('mailbox-close').click();
      assert.equal(await draft.inputValue(), draftText);
      await page.reload();
      await chat.getByTestId('decision-result-label').waitFor();
      await chat.locator('button[aria-expanded="false"]').click();
      await chat.getByTestId('memory-correction-chat-result').waitFor();
      await page.screenshot({ path: path.join(evidence, 'chat-cold-result.png'), fullPage: true });
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('approval-item-inbox-native-approve').waitFor();
      const recovering = source.records.find((r) => r.verb === 'recover');
      // Recovery is still actionable; terminal originals are absent from this pending panel.
      assert.equal(
        await page.getByTestId('mailbox-panel').getByTestId(`memory-correction-${approved.proposalId}`).count(),
        0,
      );
      await page.getByTestId('mailbox-close').click();
      await page.goto(`${base}/thread/${recovering.thread.id}?shell=v2`);
      const recoveryChat = page.locator(`[data-rich-block-id="${recovering.block.id}"]`);
      const acceptWord = language === 'en' ? 'Accept this suggestion' : '接受这条建议';
      await recoveryChat.getByRole('button', { name: acceptWord, exact: true }).waitFor();
      source.failFinalizationOnce();
      await decide(page, recoveryChat, recovering, acceptWord, responses, 500);
      const interrupted = (await source.effects()).find((r) => r.verb === 'recover');
      assert.equal(interrupted.proposal.status, 'approving');
      assert.equal(interrupted.event.summary, interrupted.proposal.suggestedPatch.summary);
      assert.ok(interrupted.evidence);
      const resumeWord = language === 'en' ? 'Retry this acceptance' : '重试这次接受';
      await recoveryChat.getByRole('button', { name: resumeWord, exact: true }).waitFor();
      assert.equal(await recoveryChat.getByRole('button', { name: rejectWord, exact: true }).count(), 0);
      await freeze(page, recoveryChat);
      await page.screenshot({ path: path.join(evidence, 'chat-recovery.png'), fullPage: true });
      const recoveryDraft = page.locator('[data-testid="chat-input-composer-row"] textarea');
      await recoveryDraft.fill('Preserved same-correction recovery draft');
      await page.getByTestId('mailbox-button').click();
      const recoveryCard = page.getByTestId('mailbox-panel').getByTestId(`memory-correction-${recovering.proposalId}`);
      await recoveryCard.getByRole('button', { name: resumeWord, exact: true }).waitFor();
      const recoveryItem = f.reads.at(-1).items.find((i) => i.approval?.proposalId === recovering.proposalId);
      assert.equal(recoveryItem.approval.resolution, 'accepted');
      assert.equal(recoveryItem.approval.inlineApprovable, false);
      assert.equal(recoveryItem.approval.materialization.state, 'outcome_unknown');
      assert.equal(await recoveryCard.getByRole('button', { name: rejectWord, exact: true }).count(), 0);
      await freeze(page, recoveryCard);
      await page.screenshot({ path: path.join(evidence, 'inbox-recovery.png'), fullPage: true });
      await decide(page, recoveryCard, recovering, resumeWord, responses);
      assert.equal(responses.at(-1).body.replayed, true);
      effects = await source.effects();
      const recovered = effects.find((r) => r.verb === 'recover');
      assert.equal(recovered.proposal.status, 'approved');
      assert.equal(recovered.proposal.appliedRevision, interrupted.evidence.revision);
      assert.deepEqual(recovered.evidence, interrupted.evidence);
      assert.equal(recovered.event.summary, interrupted.event.summary);
      const recoveryResult = page.getByTestId('mailbox-retained-result');
      await recoveryResult.waitFor();
      await page.waitForFunction(({ element, word }) => element.textContent.includes(word), {
        element: await recoveryResult.elementHandle(),
        word: language === 'en' ? 'Original memory corrected' : '原记忆已更正',
      });
      await freeze(page, recoveryResult);
      await page.screenshot({ path: path.join(evidence, 'inbox-recovery-result.png'), fullPage: true });
      assert.equal(decisions.length, 4);
      assert.equal(responses.length, 4);
      await page.getByTestId('mailbox-close').click();
      assert.equal(await recoveryDraft.inputValue(), 'Preserved same-correction recovery draft');
      await page.reload();
      await recoveryChat.getByTestId('decision-result-label').waitFor();
      await recoveryChat.locator('button[aria-expanded="false"]').click();
      await recoveryChat.getByTestId('memory-correction-chat-result').waitFor();
      assert.match(await recoveryChat.innerText(), language === 'en' ? /Original memory corrected/ : /原记忆已更正/);
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('approval-item-inbox-native-approve').waitFor();
      assert.equal(
        await page
          .getByTestId('mailbox-panel')
          .locator('[data-testid^="memory-correction-memory-correction-"]')
          .count(),
        0,
      );
      assert.equal(f.reads.at(-1).items.filter((i) => i.approval?.sourceFeatureId === 'F321').length, 0);
      await freeze(page, page.getByTestId('mailbox-panel'));
      await page.screenshot({ path: path.join(evidence, 'pending-cold-retired.png'), fullPage: true });
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            render,
            responses,
            decisions,
            resultText,
            effects,
            reads: f.reads,
            mutations: f.mutations,
            errors,
            draftPreserved: true,
            boundary:
              'Real Next, original Chat/Inbox cards, canonical owner reads and original session/CSRF writer. Private SQLite only; no Redis, provider, production, Alpha/runtime or whole17 acceptance.',
          },
          null,
          2,
        ),
      );
    });

function eventRevision(value) {
  return value.evidence?.revision;
}
