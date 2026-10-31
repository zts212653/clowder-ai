import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxPersonMemoryFixture } from './f322-inbox-person-memory.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const root = process.env.F322_INBOX_PARITY_EVIDENCE ?? path.join(tree, '.tmp/f322-person-memory');
async function freeze(page, target, file) {
  const inChat = await target.evaluate((el) => Boolean(el.closest('[data-chat-container]')));
  if (inChat) {
    const port = await page.locator('[data-chat-container]').boundingBox();
    assert.ok(port);
    await page.mouse.move(port.x + 8, port.y + 24);
    await page.mouse.wheel(0, -1);
  }
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Capture the actual tested element, rather than a whole page that can follow a newer card.
  const isResultFragment = await target.evaluate((el) =>
    ['decision-result-label', 'person-memory-result'].includes(el.getAttribute('data-testid')),
  );
  const frame = inChat && isResultFragment ? target.locator('xpath=ancestor::*[@data-rich-block-id][1]') : target;
  await frame.screenshot({ path: file });
}
async function postThrough(page, record, verb, responses, press) {
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/person-memory-proposals/${record.proposalId}/${verb}` &&
      r.request().method() === 'POST',
  );
  await press();
  const response = await pending,
    body = await response.json();
  responses.push({
    entrance: record.entrance,
    proposalId: record.proposalId,
    verb,
    status: response.status(),
    request: response.request().postDataJSON(),
    body,
  });
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}
async function enabled(button) {
  await button.waitFor();
  await button.page().waitForFunction((element) => !element.disabled, await button.elementHandle());
}
async function approve(page, card, record, responses) {
  const button = card.getByTestId('person-memory-approve-selected');
  await enabled(button);
  return postThrough(page, record, 'approve', responses, async () => {
    await button.focus();
    await page.keyboard.press('Enter');
  });
}
async function reject(page, card, record, responses) {
  const button = card.getByTestId('person-memory-reject');
  await enabled(button);
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[value="other"]').check();
  await dialog.getByTestId('feedback-other-detail').fill('This evidence is not what I said.');
  return postThrough(page, record, 'reject', responses, () => dialog.getByTestId('feedback-submit').click());
}
for (const language of ['zh', 'en'])
  for (const width of [1440, 390]) {
    test(`F322 original person memory Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(root, 'person-memory', `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      const fixture = await createInboxPersonMemoryFixture(language),
        source = fixture.approvalSources;
      const chatRecords = source.records.filter((r) => r.entrance === 'Chat'),
        inboxRecords = source.records.filter((r) => r.entrance === 'Inbox');
      let environment, server, browser, page;
      const responses = [],
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
                  errors,
                  mutations: fixture.mutations,
                  reads: fixture.reads,
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
            fixture.close(),
          ]);
          const failed = cleanup.filter((r) => r.status === 'rejected');
          if (failed.length)
            throw new AggregateError(
              failed.map((r) => r.reason),
              'Owned person memory cleanup failed',
            );
        }
      });
      const port = await availablePort();
      environment = await createNextDevTestEnvironment(`f322-person-memory-${language}-${width}`, {
        API_SERVER_PORT: String(fixture.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
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
      const base = `http://127.0.0.1:${port}`,
        threadId = chatRecords[0].thread.id;
      await waitForHttp(`${base}/thread/${threadId}`, server);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', lang);
      }, language);
      await page.goto(`${base}/thread/${threadId}?shell=v2`);
      const draft = page.locator('[data-testid="chat-input-composer-row"] textarea'),
        draftText = 'Preserved original person memory draft';
      await draft.fill(draftText);
      const selected = chatRecords.find((r) => r.verb === 'approve'),
        rejected = chatRecords.find((r) => r.verb === 'reject');
      const card = page.locator(`[data-rich-block-id="${selected.block.id}"]`);
      await card.getByTestId('person-memory-approve-selected').waitFor();
      assert.equal(await card.locator('input[type="checkbox"]').count(), 2);
      await card
        .getByText(language === 'en' ? 'Original words and evidence' : '原话与证据', { exact: true })
        .first()
        .click();
      await freeze(page, card, path.join(evidence, 'Chat-before.png'));
      await card.locator('input[type="checkbox"]').nth(1).uncheck();
      const first = await approve(page, card, selected, responses);
      assert.equal(first.status, 'partially_materialized');
      assert.deepEqual(first.selectedDraftIds, [selected.draftIds[0]]);
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          1,
        selected.block.id,
      );
      const partialEffects = (await source.effects()).find((r) => r.proposalId === selected.proposalId);
      assert.equal(partialEffects.claims.length, 1);
      await freeze(page, card, path.join(evidence, 'Chat-partial.png'));
      assert.equal(
        await card.getByTestId('decision-result-label').count(),
        0,
        'A partial decision keeps the remaining selector open',
      );
      await enabled(card.getByTestId('person-memory-undo'));
      const undone = await postThrough(page, selected, 'undo', responses, () =>
        card.getByTestId('person-memory-undo').click(),
      );
      assert.equal(undone.status, 'pending_approval');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          2,
        selected.block.id,
      );
      assert.equal((await source.effects()).find((r) => r.proposalId === selected.proposalId).claims.length, 0);
      await card.locator('input[type="checkbox"]').nth(1).uncheck();
      const repeated = await approve(page, card, selected, responses);
      assert.equal(repeated.status, 'partially_materialized');
      assert.notEqual(repeated.decisionId, first.decisionId);
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          1,
        selected.block.id,
      );
      const complete = await approve(page, card, selected, responses);
      assert.equal(complete.status, 'materialized');
      assert.equal((await source.effects()).find((r) => r.proposalId === selected.proposalId).claims.length, 2);
      await card.getByTestId('decision-result-label').waitFor();
      await freeze(page, card, path.join(evidence, 'Chat-written-collapsed.png'));
      await card.locator('button[aria-expanded="false"]').click();
      await enabled(card.getByTestId('person-memory-undo'));
      assert.match(await card.locator('h3').innerText(), /Lin Chat approve/);
      await freeze(page, card, path.join(evidence, 'Chat-written.png'));
      await page.getByTestId('mailbox-button').click();
      const coldWritten = page.locator(
        `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify(['F276', selected.proposalId])}']`,
      );
      await coldWritten.getByTestId('decision-result-label').waitFor();
      assert.match(
        await coldWritten.getByTestId('decision-result-label').innerText(),
        language === 'en' ? /Written to memory.*Lin Chat approve/ : /已写入.*Lin Chat approve/,
      );
      await freeze(page, coldWritten, path.join(evidence, 'Inbox-cold-materialized-collapsed.png'));
      await coldWritten.locator('button[aria-expanded="false"]').click();
      await coldWritten.getByTestId('approval-receipt-original').waitFor();
      assert.match(
        await coldWritten.getByTestId('approval-receipt-original').innerText(),
        language === 'en' ? /Lin enjoys hiking/ : /林喜欢爬山/,
      );
      await enabled(coldWritten.getByTestId('person-memory-undo'));
      assert.equal(
        await coldWritten.locator('form, input, textarea, [data-testid="person-memory-approve-selected"]').count(),
        0,
      );
      await freeze(page, coldWritten, path.join(evidence, 'Inbox-cold-materialized-original.png'));
      await page.getByTestId('mailbox-close').click();
      await postThrough(page, selected, 'undo', responses, () => card.getByTestId('person-memory-undo').click());
      await card
        .getByTestId('decision-result-label')
        .filter({ hasText: language === 'en' ? 'This write was undone' : '已撤销本次写入' })
        .waitFor();
      const partialRejected = page.locator(`[data-rich-block-id="${rejected.block.id}"]`);
      await enabled(partialRejected.getByTestId('person-memory-approve-selected'));
      await partialRejected.locator('input[type="checkbox"]').nth(1).uncheck();
      assert.equal((await approve(page, partialRejected, rejected, responses)).status, 'partially_materialized');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-rich-block-id="${id}"]`)?.querySelectorAll('input[type="checkbox"]').length ===
          1,
        rejected.block.id,
      );
      await reject(page, partialRejected, rejected, responses);
      await partialRejected
        .getByTestId('decision-result-label')
        .filter({ hasText: language === 'en' ? 'Wrote 2' : '已写入 2 条' })
        .waitFor();
      const retained = (await source.effects()).find((r) => r.proposalId === rejected.proposalId);
      assert.equal(retained.claims.length, 1);
      assert.equal(retained.relationships.length, 1); // Both persisted objects belong in the one-line total.

      await freeze(
        page,
        page.locator(`[data-rich-block-id="${rejected.block.id}"]`),
        path.join(evidence, 'Chat-rejected.png'),
      );
      await page.getByTestId('mailbox-button').click();
      const panel = page.getByTestId('mailbox-panel');
      for (const record of inboxRecords) {
        const current = panel.getByTestId(`approval-item-${record.proposalId}`);
        await current.getByTestId('person-memory-approve-selected').waitFor();
        assert.equal(await current.locator('input[type="checkbox"]').count(), 2);
        const row = current.locator('xpath=ancestor::li[@data-testid="mailbox-item"]');
        assert.equal(await row.count(), 1);
        assert.equal(await row.locator('[data-testid="mailbox-item-ignore"]').count(), 1);
        const ignoreBox = await row.getByTestId('mailbox-item-ignore').boundingBox(),
          openBox = await row.getByTestId('mailbox-open-original').boundingBox(),
          rowBox = await row.boundingBox();
        assert.ok(ignoreBox && openBox && rowBox);
        assert.ok(Math.abs(ignoreBox.y - openBox.y) <= 1, 'Ignore and Open original must share one footer row');
        assert.ok(openBox.x + openBox.width >= rowBox.x + rowBox.width - 32, 'Original actions stay right aligned');
        await freeze(page, current, path.join(evidence, `Inbox-${record.verb}-before.png`));
        if (record.verb === 'reject') {
          // Historical partial Undo is retained as an epoch marker, then a fresh reject is the final disposition.
          await current.locator('input[type="checkbox"]').nth(1).uncheck();
          assert.equal((await approve(page, current, record, responses)).status, 'partially_materialized');
          await enabled(current.getByTestId('person-memory-undo'));
          assert.equal(
            (
              await postThrough(page, record, 'undo', responses, () =>
                current.getByTestId('person-memory-undo').click(),
              )
            ).status,
            'pending_approval',
          );
          await page.waitForFunction(
            (id) =>
              document.querySelector(`[data-testid="approval-item-${id}"]`)?.querySelectorAll('input[type="checkbox"]')
                .length === 2,
            record.proposalId,
          );
          await reject(page, current, record, responses);
          continue;
        }
        const later = await postThrough(page, record, 'not-now', responses, () =>
          current.getByTestId('person-memory-not-now').click(),
        );
        assert.equal(later.status, 'not_now');
        await enabled(current.getByTestId('person-memory-approve-selected'));
        await current.locator('input[type="checkbox"]').nth(1).uncheck();
        const part = await approve(page, current, record, responses);
        assert.equal(part.status, 'partially_materialized');
        await page.waitForFunction(
          (id) =>
            document.querySelector(`[data-testid="approval-item-${id}"]`)?.querySelectorAll('input[type="checkbox"]')
              .length === 1,
          record.proposalId,
        );
        await freeze(page, current, path.join(evidence, 'Inbox-partial.png'));
        const whole = await approve(page, current, record, responses);
        assert.equal(whole.status, 'materialized');
        const result = panel.getByTestId('mailbox-retained-result').filter({ hasText: 'Lin Inbox approve' });
        await result.getByTestId('decision-result-label').waitFor();
        await freeze(page, result, path.join(evidence, 'Inbox-result-collapsed.png'));
        await result.locator('button[aria-expanded="false"]').click();
        await enabled(result.getByTestId('person-memory-undo'));
        assert.match(await result.getByTestId('person-memory-result-subject').innerText(), /Lin Inbox approve/);
        await freeze(page, result, path.join(evidence, 'Inbox-result-with-undo.png'));
        const resultUndo = await postThrough(page, record, 'undo', responses, () =>
          result.getByTestId('person-memory-undo').click(),
        );
        assert.equal(resultUndo.status, 'withdrawn');
        await result
          .getByTestId('decision-result-label')
          .filter({
            hasText: language === 'en' ? 'This write was undone' : '已撤销本次写入',
          })
          .waitFor();
        await freeze(page, result, path.join(evidence, 'Inbox-undone-collapsed.png'));
        await result.locator('button[aria-expanded="false"]').click();
        await result.getByTestId('person-memory-result-subject').waitFor();
        assert.equal(
          await result.getByTestId('person-memory-undo-result').count(),
          0,
          'The original does not repeat the result',
        );
        assert.equal(
          await result.getByTestId('person-memory-undo').count(),
          0,
          'An undone write cannot be undone again',
        );
        assert.equal(await result.locator('input,select,textarea,form').count(), 0);
        await freeze(page, panel, path.join(evidence, 'Inbox-undone.png'));
      }
      const replacement = await source.createReplacement(chatRecords[0].thread);
      const personWritesBeforeCold = fixture.mutations.filter((request) =>
        request.path.startsWith('/api/person-memory-proposals/'),
      ).length;
      const effects = await source.effects();
      for (const record of source.records) {
        const effect = effects.find((r) => r.proposalId === record.proposalId);
        assert.equal(effect.candidate.state, record.verb === 'approve' ? 'withdrawn' : 'rejected');
        assert.equal(effect.candidateTtl, -1);
        assert.equal(effect.claims.length, record.verb === 'approve' || record.entrance === 'Chat' ? 1 : 0);
      }
      await page.getByTestId('mailbox-close').click();
      assert.equal(await draft.inputValue(), draftText);
      await page.reload();
      await page.locator(`[data-rich-block-id="${selected.block.id}"]`).getByTestId('decision-result-label').waitFor();
      await page.locator(`[data-rich-block-id="${selected.block.id}"] button[aria-expanded="false"]`).click();
      await page.locator(`[data-rich-block-id="${rejected.block.id}"]`).getByTestId('decision-result-label').waitFor();
      assert.match(
        await page.locator(`[data-rich-block-id="${selected.block.id}"]`).locator('h3').innerText(),
        /Lin Chat approve/,
      );
      await freeze(
        page,
        page.locator(`[data-rich-block-id="${selected.block.id}"]`),
        path.join(evidence, 'Chat-cold-result.png'),
      );
      assert.match(
        await page
          .locator(`[data-rich-block-id="${rejected.block.id}"]`)
          .getByTestId('decision-result-label')
          .innerText(),
        language === 'en' ? /Wrote 2.*rest declined/ : /已写入 2 条.*其余没写/,
      );
      await freeze(
        page,
        page.locator(`[data-rich-block-id="${rejected.block.id}"]`),
        path.join(evidence, 'Chat-cold-part-written-rest-declined.png'),
      );
      const replacementChat = page.locator(`[data-rich-block-id="${replacement.original.block.id}"]`);
      const closed = language === 'en' ? 'Closed' : '已关闭';
      const withdrawn = language === 'en' ? 'Withdrawn' : '已撤回';
      const undoneText = language === 'en' ? 'This write was undone' : '已撤销本次写入';
      await replacementChat.getByTestId('decision-result-label').waitFor();
      assert.ok((await replacementChat.getByTestId('decision-result-label').innerText()).includes(closed));
      const chatDot = await replacementChat.getByTestId('decision-result-dot').boundingBox();
      assert.equal(chatDot?.width, 8);
      assert.equal(chatDot?.height, 8);
      await replacementChat.locator('button[aria-expanded="false"]').click();
      assert.equal(await replacementChat.getByTestId('decision-result-details').locator('output').count(), 0);
      assert.ok(!(await replacementChat.innerText()).includes(withdrawn));
      assert.ok(!(await replacementChat.innerText()).includes(undoneText));
      assert.equal(
        await replacementChat.locator('form, input, select, textarea, [data-testid="person-memory-undo"]').count(),
        0,
      );
      await freeze(
        page,
        replacementChat.getByTestId('decision-result-label'),
        path.join(evidence, 'replacement-Chat-cold-header.png'),
      );
      await freeze(
        page,
        replacementChat.getByTestId('decision-result-details'),
        path.join(evidence, 'replacement-Chat-cold-expanded.png'),
      );
      await page.getByTestId('mailbox-button').click();
      await panel.getByTestId('approval-item-inbox-native-approve').waitFor();
      for (const record of source.records) {
        assert.equal(await panel.getByTestId(`approval-item-${record.proposalId}`).count(), 0);
        const receipt = panel.locator(
          `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify(['F276', record.proposalId])}']`,
        );
        await receipt.getByTestId('decision-result-label').waitFor();
        assert.match(
          await receipt.getByTestId('decision-result-label').innerText(),
          language === 'en' ? /Person memory/ : /记人的记忆/,
        );
        assert.match(
          await receipt.getByTestId('decision-result-label').innerText(),
          record.verb === 'approve'
            ? language === 'en'
              ? /This write was undone/
              : /已撤销本次写入/
            : record.entrance === 'Chat'
              ? language === 'en'
                ? /Wrote 2.*rest declined/
                : /已写入 2 条.*其余没写/
              : language === 'en'
                ? /Declined/
                : /已拒绝/,
        );
        await freeze(page, receipt, path.join(evidence, `${record.proposalId}-cold-collapsed.png`));
        assert.equal(
          await receipt.getByTestId('decision-result-dot').getAttribute('data-status'),
          record.verb === 'approve' ? 'withdrawn' : record.entrance === 'Chat' ? 'approved' : 'rejected',
        );
        await receipt.locator('button[aria-expanded="false"]').click();
        await receipt.getByTestId('approval-receipt-original').waitFor();
        assert.match(await receipt.getByTestId('approval-receipt-original').innerText(), /Hangzhou|杭州/);
        assert.equal(
          await receipt.locator('form, input, select, textarea, [data-testid="person-memory-undo"]').count(),
          0,
        );
        const textAfterDisclosure = await receipt.getByTestId('decision-result-label').innerText();
        if (record.verb === 'reject') {
          assert.ok(!textAfterDisclosure.includes(language === 'en' ? 'This write was undone' : '已撤销本次写入'));
          if (record.entrance === 'Chat')
            assert.match(textAfterDisclosure, language === 'en' ? /Wrote 2.*rest declined/ : /已写入 2 条.*其余没写/);
        }
        await freeze(page, receipt, path.join(evidence, `${record.proposalId}-cold-original.png`));
      }
      const replacementInbox = panel.locator(
        `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify(['F276', replacement.original.proposalId])}']`,
      );
      await replacementInbox.getByTestId('decision-result-label').waitFor();
      assert.ok((await replacementInbox.getByTestId('decision-result-label').innerText()).includes(closed));
      const inboxDot = await replacementInbox.getByTestId('decision-result-dot').boundingBox();
      assert.equal(inboxDot?.width, 8);
      assert.equal(inboxDot?.height, 8);
      await replacementInbox.locator('button[aria-expanded="false"]').click();
      await replacementInbox.getByTestId('approval-receipt-original').waitFor();
      assert.equal(await replacementInbox.locator('output').count(), 0); // The canonical header is the sole result statement.
      assert.ok(!(await replacementInbox.innerText()).includes(withdrawn));
      assert.ok(!(await replacementInbox.innerText()).includes(undoneText));
      assert.equal(
        await replacementInbox.locator('form, input, select, textarea, [data-testid="person-memory-undo"]').count(),
        0,
      );
      await freeze(page, replacementInbox, path.join(evidence, 'replacement-Inbox-cold-expanded.png'));
      const pendingPerson = fixture.reads.at(-1).items.filter((item) => item.approval?.sourceFeatureId === 'F276');
      assert.deepEqual(
        pendingPerson.map((item) => item.approval.proposalId),
        [replacement.successor.proposalId],
      );
      assert.equal(
        fixture.mutations.filter((request) => request.path.startsWith('/api/person-memory-proposals/')).length,
        personWritesBeforeCold,
        'Cold Chat/Inbox disclosure must not issue a person-memory write',
      );
      assert.deepEqual(errors, []);
      await freeze(page, panel, path.join(evidence, 'Inbox-cold-results-retained.png'));
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            language,
            width,
            responses,
            effects,
            replacement,
            reads: fixture.reads,
            mutations: fixture.mutations,
            errors,
            draftPreserved: true,
            boundary:
              'Actual Next, original F276 Ingress/adapter/decision routes and Redis Lua store on development6398/db15 with unique owned namespace. Partial selection, exact undo, reapprove, feedback rejection and cold retained results. Replacement precondition uses real producer partial approve, Undo reopen and atomic successor publication; Chat/Inbox disclose the replaced original read-only and preserve the genuinely pending successor. No runtime/provider or whole17 acceptance.',
          },
          null,
          2,
        ),
      );
    });
  }
