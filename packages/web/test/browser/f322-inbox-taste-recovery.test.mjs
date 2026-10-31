import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxInformationFixture } from './f322-inbox-information.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const root = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-taste-recovery');
async function freeze(page, element) {
  await element.scrollIntoViewIfNeeded();
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
async function approve(page, card, id, responses, expected) {
  const button = card.getByTestId('approve-btn');
  await button.waitFor();
  await page.waitForFunction((element) => !element.disabled, await button.elementHandle());
  const waiting = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/taste-proposals/${id}/approve` && r.request().method() === 'POST',
  );
  await button.focus();
  await page.keyboard.press('Enter');
  const response = await waiting,
    body = await response.json();
  responses.push({ path: new URL(response.url()).pathname, status: response.status(), body });
  assert.equal(response.status(), expected, JSON.stringify(body));
  return body;
}
for (const language of ['zh', 'en'])
  for (const width of [1440, 390]) {
    test(`F322 original taste recovery Chat to Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(root, 'taste-recovery', `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const f = await createInboxInformationFixture(language),
        source = f.approvalSources;
      const record = source.records.find((r) => r.kind === 'F221' && r.verb === 'approve');
      let environment, server, browser, page;
      const responses = [],
        decisions = [],
        errors = [];
      t.after(async () => {
        try {
          if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
            await writeFile(
              path.join(evidence, 'final-state.json'),
              JSON.stringify(
                {
                  text: await page.locator('body').innerText(),
                  responses,
                  decisions,
                  errors,
                  reads: f.reads,
                  mutations: f.mutations,
                  proposal: source.taste.get(record.proposalId),
                  effects: await source.effects(),
                },
                null,
                2,
              ),
            );
          }
        } finally {
          const cleanup = await Promise.allSettled([
            browser?.close(),
            (async () => {
              // Next must stop writing before its owned build directory is removed.
              if (server) await stopChild(server);
              await environment?.cleanup();
            })(),
            f.close(),
          ]);
          const failed = cleanup.filter((r) => r.status === 'rejected');
          if (failed.length)
            throw new AggregateError(
              failed.map((r) => r.reason),
              'Owned taste recovery cleanup failed',
            );
        }
      });
      const port = await availablePort();
      environment = await createNextDevTestEnvironment(`f322-taste-recovery-${language}-${width}`, {
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
        { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
      const base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/thread/${record.thread.id}`, server);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === `/api/taste-proposals/${record.proposalId}/approve`
        )
          decisions.push({ path: new URL(request.url()).pathname, body: request.postData() });
      });
      await page.addInitScript((lang) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', lang);
      }, language);
      await page.goto(`${base}/thread/${record.thread.id}?shell=v2`);
      const chat = page.locator(`[data-rich-block-id="${record.block.id}"]`);
      await chat.getByTestId('approve-btn').waitFor();
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea'),
        draftText = 'Preserved original taste recovery draft';
      await draft.fill(draftText);
      source.failTasteFinalizationOnce();
      await approve(page, chat, record.proposalId, responses, 500);
      const interrupted = source.taste.get(record.proposalId);
      assert.equal(interrupted.status, 'approving');
      assert.ok(interrupted.vignettePath);
      const resume = language === 'en' ? 'Continue writing' : '继续写入';
      await chat.getByRole('button', { name: resume, exact: true }).waitFor();
      assert.equal(await chat.getByTestId('reject-btn').count(), 0);
      await freeze(page, chat);
      await page.screenshot({ path: path.join(evidence, 'chat-recovery.png'), fullPage: true });
      await page.getByTestId('mailbox-button').click();
      const panel = page.getByTestId('mailbox-panel'),
        card = panel.getByTestId(`approval-item-${record.proposalId}`);
      await card.getByRole('button', { name: resume, exact: true }).waitFor();
      assert.equal(await card.getByTestId('reject-btn').count(), 0);
      assert.equal(await card.getByTestId('mailbox-item-ignore').count(), 1);
      const row = f.reads.at(-1).items.find((i) => i.approval?.proposalId === record.proposalId);
      assert.equal(row.approval.resolution, 'accepted');
      assert.equal(row.approval.materialization.state, 'outcome_unknown');
      assert.equal(row.approval.inlineApprovable, false);
      assert.equal(row.approval.decisionMode, undefined);
      assert.deepEqual(row.originalApprovalCard.block, record.block);
      assert.deepEqual(row.originalApprovalCard.cardRef, {
        ...record.envelope.approvalCardRef,
        blockId: record.block.id,
      });
      const buttons = await card
        .getByTestId('domain-approval-place-actions')
        .getByRole('button')
        .evaluateAll((elements) =>
          elements.map((e) => ({ y: e.getBoundingClientRect().y, right: e.getBoundingClientRect().right })),
        );
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].y, buttons[1].y);
      await freeze(page, card);
      await page.screenshot({ path: path.join(evidence, 'inbox-recovery.png'), fullPage: true });
      const receipt = await approve(page, card, record.proposalId, responses, 200);
      assert.equal(receipt.status, 'approved');
      assert.equal(receipt.recovered, true);
      assert.equal(receipt.vignettePath, interrupted.vignettePath);
      const result = panel
        .getByTestId('mailbox-retained-line')
        .filter({ hasText: language === 'en' ? 'Taste written' : '品味已写入' });
      await result.waitFor();
      await freeze(page, result);
      assert.match(await result.innerText(), language === 'en' ? /You/ : /你/);
      await page.screenshot({ path: path.join(evidence, 'inbox-result.png'), fullPage: true });
      const effects = await source.effects();
      assert.equal(effects.vignettes.length, 1);
      assert.equal(effects.vignettes[0].path, interrupted.vignettePath);
      assert.ok(effects.vignettes[0].content.includes('Keep the original evidence'));
      assert.equal(effects.deliveries.length, 0);
      assert.ok(effects.entities.every((e) => e === null));
      assert.equal(decisions.length, 2);
      await page.getByTestId('mailbox-close').click();
      assert.equal(await draft.inputValue(), draftText);
      await page.reload();
      await chat.getByTestId('decision-result-label').waitFor();
      await chat.locator('button[aria-expanded="false"]').click();
      await chat.getByTestId('domain-approval-result').waitFor();
      assert.match(await chat.innerText(), language === 'en' ? /Taste written/ : /品味已写入/);
      assert.equal(await chat.getByTestId('approve-btn').count(), 0);
      await freeze(page, chat);
      await page.screenshot({ path: path.join(evidence, 'chat-cold-result.png'), fullPage: true });
      await page.getByTestId('mailbox-button').click();
      await panel.getByTestId('approval-item-inbox-native-approve').waitFor();
      assert.equal(await panel.getByTestId(`approval-item-${record.proposalId}`).count(), 0);
      assert.ok(!f.reads.at(-1).items.some((i) => i.approval?.proposalId === record.proposalId));
      assert.ok(f.reads.at(-1).items.some((i) => i.approval?.proposalId === 'information-taste-reject'));
      assert.deepEqual(errors, []);
      await freeze(page, panel);
      await page.screenshot({ path: path.join(evidence, 'pending-cold-retired.png'), fullPage: true });
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            responses,
            decisions,
            interrupted,
            finalProposal: source.taste.get(record.proposalId),
            effects,
            reads: f.reads,
            mutations: f.mutations,
            errors,
            draftPreserved: true,
            boundary:
              'Real Next, same original Chat/Inbox F221 controller, two original POSTs with one checkpointed private vignette. Other requests remain pending; no new source/writer/store or whole17/Alpha/runtime acceptance.',
          },
          null,
          2,
        ),
      );
    });
  }
