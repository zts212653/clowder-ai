import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import {
  assertCandidateTextContrast,
  assertDocumentGroupFocus,
  assertDocumentOutcomeVisible,
  assertDocumentReceipt,
  assertHitTarget,
  assertPublishedDocumentQuotes,
  probeDocumentReceiptClick,
  recordDocumentJourney,
} from './f309-document-journey-assertions.mjs';
import { createDocumentRequest, DOCUMENT_TEXT } from './f309-ordinary-document-request.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import {
  assertFitsViewport,
  assertReadable,
  EVIDENCE,
  measureContrast,
} from './f309-ordinary-workspace-journey-chat-progress.mjs';

async function openFile(page, filename) {
  const home = await openWorkspaceTools(page);
  await home.getByTestId('workspace-launcher-search').fill(filename);
  await home
    .getByTestId('workspace-launcher-file-result')
    .filter({ has: page.getByText(filename, { exact: true }) })
    .first()
    .click();
  await page.getByTestId('workspace-content-review-text').waitFor();
}

async function queueDocumentQuote(page, text, comment) {
  const paper = page.getByTestId('workspace-content-review-text');
  const passage = paper.getByText(text, { exact: true });
  await passage.scrollIntoViewIfNeeded();
  const rect = await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length !== 1) throw new Error('the fixture passage must be one visible text line');
    const rect = rects[0];
    return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
  });
  // Actual pointer selection also leaves a previously focused text editor; setting a DOM Range alone does not.
  await page.mouse.move(rect.left + 0.1, rect.top + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.right + 0.1, rect.top + rect.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString().trim()), text);
  try {
    await page.getByTestId('workspace-content-review-text-add-to-chat').click({ timeout: 4000 });
  } catch (error) {
    const selection = await page.evaluate(() => ({
      text: window.getSelection()?.toString(),
      focused: document.activeElement?.outerHTML.slice(0, 400),
    }));
    throw new Error(`${error}\nselection=${JSON.stringify(selection)}`);
  }
  const editor = page.getByTestId('context-annotation-comment');
  await editor.fill(comment);
  await editor.press('Enter');
  await editor.waitFor({ state: 'hidden' });
}

function assertTaskDisposition(fixture, decision) {
  const task = fixture.owner.tasks.get(fixture.taskId);
  if (decision === 'cancel-sole') {
    assert.equal(task.entrustedWork.closure.state, 'cancelled');
    assert.equal(task.entrustedWork.closure.disposition.kind, 'cancelled');
    assert.equal(task.entrustedWork.closure.disposition.actorKind, 'human');
    assert.equal(task.entrustedWork.closure.disposition.actorRef, 'user:operator');
  } else
    assert.equal(
      task.status,
      fixture.taskStatus,
      'a shared responsibility or candidate decision does not invent Task completion',
    );
}

async function cancelDocument(f, session, decision) {
  const { page, calls } = session;
  const row = page.locator(`[data-message-id="${f.message.id}"]`).getByTestId('modification-progress');
  await row.getByRole('button', { name: '取消修改' }).click();
  await page
    .locator(
      `[data-message-id="${f.message.id}"] [data-testid="modification-progress"][data-state="cancelled_still_running"]`,
    )
    .waitFor();
  const view = await f.owner.integration.requests.read(f.record.requestId, f.owner.human);
  assert.equal(view.record.control.state, 'cancelled');
  assert.equal(view.execution.state, 'running');
  assert.equal(view.record.control.taskResolution, decision === 'cancel' ? 'preserved' : 'closed');
  assert.equal(calls.filter((call) => call.path.endsWith('/cancel') && call.method === 'POST').length, 1);
}

async function decideDocument(f, page, decision, candidate) {
  await page.locator(`[data-message-id="${candidate.receipt.id}"]`).getByRole('button', { name: '打开对照' }).click();
  const result = page.locator(`[data-candidate-ref="${candidate.returned.proposalRef}"]`);
  await result.waitFor({ state: 'visible' });
  if (decision === 'reject') {
    await result.getByRole('button', { name: '不采用', exact: true }).click();
    await assertDocumentOutcomeVisible(page, result, '已拒绝此候选；候选和原讨论仍保留。');
  } else {
    await writeFile(f.absolute, `${DOCUMENT_TEXT}\nOwner changed this separately.\n`);
    await result.getByTestId('content-modification-accept').click();
    await assertDocumentOutcomeVisible(page, result, '原文件已有改动，尚未写回；新版本已保留。');
    assert.equal(await readFile(f.absolute, 'utf8'), `${DOCUMENT_TEXT}\nOwner changed this separately.\n`);
  }
}

/** Production history/owner + sealed callback + actual CAS. Config/session/provider are declared test boundaries. */
export function registerOrdinaryDocumentJourney(suite) {
  const contrast = { values: {}, file: `${EVIDENCE}/contrast-document-owner.json` };
  test(
    'document work progress: active A survives later untaken B and cancels exact A',
    { timeout: 90000 },
    async () => {
      const f = await createDocumentRequest();
      let session;
      try {
        const later = f.owner.messages.append({
          userId: 'operator',
          threadId: f.owner.thread.id,
          from: { kind: 'user', userId: 'operator' },
          mentions: [],
          timestamp: Date.now(),
          content: '同一文件的另一个尚未接手的想法',
          contentBlocks: structuredClone(f.message.contentBlocks),
        });
        const untaken = await f.owner.app.inject({ url: `/api/content-modifications/by-message/${later.id}` });
        assert.equal(untaken.statusCode, 404);
        session = await openDocumentSession(suite, f.owner, { shell: 'v2' });
        const { page, calls, errors } = session;
        await page.locator('[data-testid="workspace-panel-toggle"][data-client-interactive="true"]').waitFor();
        const composer = page.getByLabel('消息输入框');
        await composer.fill('另一个未发送的文档想法');
        await openFile(page, f.filename);
        const work = page.getByTestId('text-work-progress').getByTestId('modification-progress');
        await work.waitFor();
        assert.equal(await work.count(), 1);
        assert.equal(await work.getAttribute('data-state'), 'working');
        assert.ok((await work.textContent()).includes(f.filename));
        await work.getByRole('button', { name: '取消修改', exact: true }).click();
        await page.getByTestId('text-work-progress').locator('[data-state="cancelled_still_running"]').waitFor();
        const actual = await f.owner.integration.requests.read(f.record.requestId, f.owner.human);
        assert.equal(actual.record.control.state, 'cancelled');
        assert.equal(actual.record.progress.sourceMessageId, f.message.id);
        assert.deepEqual(
          calls.filter((call) => call.method === 'POST' && call.path.endsWith('/cancel')).map((call) => call.path),
          [`/api/content-modifications/${f.record.requestId}/cancel`],
        );
        assert.equal(await composer.inputValue(), '另一个未发送的文档想法');
        assert.equal(
          (await f.owner.app.inject({ url: `/api/content-modifications/by-message/${later.id}` })).statusCode,
          404,
        );
        await page.screenshot({ path: `${EVIDENCE}/r1-document-work-progress.png` });
        await writeFile(
          `${EVIDENCE}/r1-document-work-progress.json`,
          JSON.stringify(
            {
              url: page.url(),
              ownerApi: f.owner.api,
              requestId: f.record.requestId,
              activeMessageId: f.message.id,
              untakenMessageId: later.id,
              errors,
            },
            null,
            2,
          ),
        );
        assert.deepEqual(errors, []);
      } finally {
        try {
          if (session) {
            // Drain callbacks while their page and request context are still usable.
            await session.context.unrouteAll({ behavior: 'wait' });
            await session.context.close();
          }
        } finally {
          await f.close();
        }
      }
    },
  );
  for (const [slug, width, dark] of [
    ['desktop-light', 1440, false],
    ['desktop-dark', 1440, true],
    ['390px-light', 390, false],
    ['390px-dark', 390, true],
  ]) {
    test(
      `document owner: original message, named diff, explicit CAS and exact return (${slug})`,
      { timeout: 150_000 },
      async () => {
        await mkdir(EVIDENCE, { recursive: true });
        const f = await createDocumentRequest();
        let session;
        try {
          session = await openDocumentSession(suite, f.owner, { width, dark });
          const { page, calls, errors } = session;
          const human = page.locator(`[data-message-id="${f.message.id}"]`);
          const progress = human.getByTestId('modification-progress');
          await progress.waitFor();
          assert.equal(await progress.getAttribute('data-state'), 'working');
          assert.match(await progress.locator('output').textContent(), /2\s*处/);
          await assertReadable(progress, `${slug} real owner working`, contrast);
          const initialView = await f.owner.integration.requests.read(f.record.requestId, f.owner.human);
          assert.equal(initialView.execution.state, 'running');
          assert.ok(initialView.execution.evidenceRef.startsWith('turn-execution:'));
          const cat = await assertPublishedDocumentQuotes(page, f);
          await progress.scrollIntoViewIfNeeded();
          await human.screenshot({ path: `${EVIDENCE}/document-progress-${slug}.png` });

          await openFile(page, f.filename);
          const marks = page.locator('[data-file-quote-mark]');
          await marks.first().waitFor();
          assert.equal(await marks.count(), 2, 'two distinct passages, with shared citations grouped at the first');
          for (const mark of await marks.all()) {
            await assertHitTarget(page, mark);
            const ratio = await measureContrast(mark, 'text-on-fill');
            contrast.values[`${slug} file mark ${await mark.getAttribute('data-file-quote-mark')}`] = Number(
              ratio.toFixed(2),
            );
            assert.ok(ratio >= 4.5);
          }
          await page.screenshot({ path: `${EVIDENCE}/document-file-marks-${slug}.png` });
          const taskCount = f.owner.tasks.listByThread(f.owner.thread.id).length;
          await queueDocumentQuote(page, 'Second unique paragraph.', '先记在输入框里的第二段');
          await queueDocumentQuote(page, 'First unique paragraph.', '先记在输入框里的第一段');
          const pending = page.locator('[data-pending-file-quote]');
          await pending.first().waitFor();
          assert.deepEqual(await pending.allTextContents(), ['1', '2']);
          for (const mark of await pending.all()) {
            await assertFitsViewport(page, mark);
            assert.ok((await measureContrast(mark, 'text-on-fill')) >= 4.5);
          }
          assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, taskCount, 'unsent places create no Task');
          assert.equal(await readFile(f.absolute, 'utf8'), DOCUMENT_TEXT);
          await page.screenshot({ path: `${EVIDENCE}/document-pending-two-${slug}.png` });
          await assertDocumentGroupFocus(page, f);
          await assertDocumentGroupFocus(page, f, 'Second unique paragraph.');
          assert.equal(await page.locator('[data-file-quote-reference="queued-cat-source"]').count(), 1);
          const reference = page.locator('[data-file-quote-reference="cat-source"]');
          await reference.waitFor({ state: 'visible' });
          await reference.click();
          await cat.waitFor({ state: 'visible' });
          assert.equal(new URL(page.url()).pathname, `/thread/${f.owner.thread.id}`);
          assert.ok(
            await cat.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return rect.bottom > 0 && rect.top < innerHeight;
            }),
            'file-side reference returns the exact authored source message to the viewport',
          );

          const { returned, receipt } = await f.returnCandidate();
          await page.reload({ waitUntil: 'domcontentloaded' });
          const host = page.locator(`[data-message-id="${receipt.id}"]`);
          // Prepare visibility; the probe then measures only the trusted press/release lifetime.
          await host.getByRole('button', { name: '打开对照' }).scrollIntoViewIfNeeded();
          await probeDocumentReceiptClick(page, host, receipt.id, `${EVIDENCE}/document-candidate-click-${slug}.json`);
          const result = page.locator(`[data-candidate-ref="${returned.proposalRef}"]`);
          await result.waitFor({ state: 'visible' });
          await assertFitsViewport(
            page,
            page.getByTestId('workspace-content-review-surface').getByRole('button', { name: '返回来源', exact: true }),
          );
          const edits = result.locator('[data-text-edit]');
          assert.equal(await edits.count(), 3);
          assert.match(await edits.nth(0).innerText(), /第\s*2\s*处/);
          assert.match(await edits.nth(1).innerText(), /第\s*1\s*处/);
          assert.match(await edits.nth(2).innerText(), /未关联引用的修改/);
          assert.match(await edits.nth(0).innerText(), /第一个段落改得具体些/);
          await assertCandidateTextContrast(result, slug, contrast);
          assert.equal(await readFile(f.absolute, 'utf8'), DOCUMENT_TEXT);
          await result.screenshot({ path: `${EVIDENCE}/document-candidate-${slug}.png` });
          const accept = result.getByTestId('content-modification-accept');
          await assertHitTarget(page, accept);
          assert.ok((await measureContrast(accept, 'text-on-fill')) >= 4.5);
          await page.screenshot({ path: `${EVIDENCE}/document-decisions-${slug}.png` });
          await accept.click();
          await page
            .getByTestId('workspace-content-review-text')
            .getByText('First revised paragraph.', { exact: true })
            .waitFor();
          await assertDocumentOutcomeVisible(page, result, '已写回原文件');
          const written = await readFile(f.absolute, 'utf8');
          assert.equal(
            written,
            DOCUMENT_TEXT.replace('First unique paragraph.', 'First revised paragraph.')
              .replace('Second unique paragraph.', 'Second revised paragraph.')
              .replace('Unquoted closing line.', 'Proposed closing line.'),
          );
          assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/accept')).length, 1);
          const finalView = await f.owner.integration.requests.read(f.record.requestId, f.owner.human);
          assert.equal(finalView.record.progress.task.taskId, f.taskId);
          const applied = f.owner.messages
            .getByThread(f.owner.thread.id, 200)
            .find((message) => message.extra?.contentModificationReceiptV1?.state === 'applied');
          assert.ok(applied);
          assert.equal(applied.userId, f.owner.thread.createdBy);
          assert.deepEqual(applied.from, { kind: 'system', service: 'content-modification' });
          assert.equal(applied.extra.contentModificationReceiptV1.sourceMessageId, f.message.id);
          await recordDocumentJourney(`${EVIDENCE}/document-owner-${slug}.json`, page, f, returned.proposalRef);
          await page.screenshot({ path: `${EVIDENCE}/document-written-${slug}.png` });
          await assertDocumentReceipt(page, f, 'applied', `${EVIDENCE}/document-host-applied-${slug}.png`);
          assert.deepEqual(errors, []);
          assert.deepEqual(f.owner.errors, []);
          await writeFile(contrast.file, `${JSON.stringify(contrast.values, null, 2)}\n`);
        } catch (error) {
          if (session) {
            await session.page.screenshot({ path: `${EVIDENCE}/document-failed-${slug}.png` });
            throw new Error(
              `${error}\npage: ${(await session.page.locator('body').innerText()).slice(-8000)}\nerrors: ${session.errors}`,
            );
          }
          throw error;
        } finally {
          await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
          await session?.context.close();
          await f.close();
        }
      },
    );
  }

  for (const decision of ['cancel', 'cancel-sole', 'reject', 'conflict']) {
    test(
      `document owner: ${decision} retains source and the explicit Task disposition`,
      { timeout: 120_000 },
      async () => {
        const f = await createDocumentRequest();
        let session;
        try {
          const cancelling = decision.startsWith('cancel');
          if (decision === 'cancel') await f.shareResponsibility();
          const candidate = cancelling ? null : await f.returnCandidate();
          session = await openDocumentSession(suite, f.owner);
          if (cancelling) await cancelDocument(f, session, decision);
          else await decideDocument(f, session.page, decision, candidate);
          if (decision !== 'conflict') assert.equal(await readFile(f.absolute, 'utf8'), DOCUMENT_TEXT);
          if (!cancelling)
            await assertDocumentReceipt(
              session.page,
              f,
              decision === 'reject' ? 'rejected' : 'conflict',
              `${EVIDENCE}/document-host-${decision}.png`,
            );
          assertTaskDisposition(f, decision);
          assert.deepEqual(session.errors, []);
        } finally {
          await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
          await session?.context.close();
          await f.close();
        }
      },
    );
  }

  test(
    'document owner: bounded older quotes, withdrawn access and source drift are rechecked',
    { timeout: 120_000 },
    async () => {
      const f = await createDocumentRequest();
      let session;
      try {
        // These are owner-store fixtures. Every page and permission/version check still runs the production route.
        for (let index = 0; index < 55; index++)
          f.owner.messages.append({
            userId: 'operator',
            threadId: f.owner.thread.id,
            from: { kind: 'user', userId: 'operator' },
            mentions: [],
            timestamp: Date.now(),
            content: `Unquoted history ${index}`,
          });
        const task = structuredClone(f.owner.tasks.get(f.taskId));
        session = await openDocumentSession(suite, f.owner);
        const { page } = session;
        await openFile(page, f.filename);
        await page.locator('section[aria-label^="引用消息"] summary').click();
        await page.getByRole('button', { name: '读取更多消息', exact: true }).click();
        await page.locator('[data-file-quote-mark]').first().waitFor();
        assert.equal(await page.locator('[data-file-quote-reference]').count(), 4);
        const reload = page.getByRole('button', { name: '重新读取引用消息', exact: true });
        f.owner.thread.deletedAt = Date.now();
        const withdrawn = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/workspace/file-quotes',
        );
        await reload.click();
        await withdrawn;
        await page.waitForFunction(() => document.querySelectorAll('[data-file-quote-mark]').length === 0);
        assert.equal(await page.locator('[data-file-quote-reference]').count(), 0);
        delete f.owner.thread.deletedAt;
        await writeFile(f.absolute, `${DOCUMENT_TEXT}\nA later source version.\n`);
        const drift = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/workspace/file-quotes',
        );
        await reload.click();
        assert.equal((await drift).status(), 409);
        await page
          .locator('section[aria-label^="引用消息"] output')
          .filter({ hasText: '原文已改，旧版引用仍保留。' })
          .waitFor();
        assert.equal(await page.locator('[data-file-quote-mark]').count(), 0);
        assert.deepEqual(f.owner.tasks.get(f.taskId), task, 'reading and rechecking references writes no Task state');
        assert.equal(await readFile(f.absolute, 'utf8'), `${DOCUMENT_TEXT}\nA later source version.\n`);
        assert.deepEqual(session.errors, []);
      } finally {
        await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
        await session?.context.close();
        await f.close();
      }
    },
  );
}
