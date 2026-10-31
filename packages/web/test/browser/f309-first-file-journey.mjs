import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collapseV2Workspace, openWorkspaceTools } from './f307-workspace-open.mjs';
import { createFirstFileFixture, observeFirstFileQuote } from './f309-first-file-fixture.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';

async function quoteNative(page, extension, entry, text, comment) {
  const viewer = page.getByTestId(entry === 'artwork' ? 'workspace-content-review-text' : 'workspace-file-viewer');
  const passage =
    extension === 'md' ? viewer.getByText(text, { exact: true }) : viewer.locator('.cm-line').filter({ hasText: text });
  await passage.scrollIntoViewIfNeeded();
  const rect = await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(rect.left + 0.1, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right + 0.1, rect.y, { steps: 8 });
  await page.mouse.up();
  await page
    .getByTestId(
      entry === 'artwork' ? 'workspace-content-review-text-add-to-chat' : 'workspace-code-selection-add-to-chat',
    )
    .click();
  const editor = page.getByTestId('context-annotation-comment');
  // Keep the real click/fill/Enter path: the host must promote after the controlled owner's change handler.
  await editor.click();
  await editor.fill(comment);
  assert.equal(await editor.inputValue(), comment, 'native comment survives the input event');
  await editor.press('Enter');
  await editor.waitFor({ state: 'hidden' });
}

async function assertNativeEntryReview(page, f, entry) {
  const openedReview = f.owner.fileReviewStore.get(f.reviewId);
  if (entry === 'artwork') {
    // Main #5263 intentionally opens Markdown in its existing Human artwork owner.
    // Cold Markdown callback creation remains covered by API tests; this native entry tests reuse.
    assert.ok(openedReview);
    assert.equal(openedReview.revision, 1);
    assert.equal(openedReview.contentRef, f.source.contentRef);
    assert.equal(openedReview.source.revision, f.source.revision);
    assert.deepEqual(openedReview.annotations, []);
  } else {
    assert.equal(await page.getByTestId('workspace-content-review-surface').count(), 0);
    assert.equal(openedReview, null);
  }
  return openedReview;
}

async function runFirstFileJourney(suite, scenario) {
  const { extension, width, shell, entry } = scenario;
  const slug = `${extension}-${width}-${shell}`;
  const f = await createFirstFileFixture(extension);
  let session;
  let openedReview = null;
  await mkdir(EVIDENCE, { recursive: true });
  try {
    session = await openDocumentSession(suite, f.owner, scenario);
    await f.captureNativeSend(session.context, () => openedReview);
    const { page, calls } = session;
    const tools = await openWorkspaceTools(page);
    await tools.locator('[data-workspace-destination="surface:files"]').click();
    await page.getByTestId('f307-files-owner-surface').waitFor();
    const search = page.getByPlaceholder('搜索当前工作区…', { exact: true });
    await search.fill(f.filename);
    await search.press('Enter');
    await page.locator(`[data-search-result-path=${JSON.stringify(f.filePath)}][data-search-result-line="0"]`).click();
    await page.getByTestId(entry === 'artwork' ? 'workspace-content-review-text' : 'workspace-file-viewer').waitFor();
    if (extension === 'md') {
      const reader = page.getByTestId('workspace-file-viewer');
      assert.equal(await reader.count(), 1, 'the original file reader shares the annotation page');
      assert.equal(await page.getByRole('button', { name: '文件工具', exact: true }).count(), 0);
      assert.equal(await reader.getByRole('button', { name: '请猫修改', exact: true }).count(), 1);
      if ((await page.getByRole('button', { name: '朗读', exact: true }).count()) === 0) {
        await reader.locator('summary[title="更多文件操作"]').click();
        await page.getByRole('button', { name: '朗读', exact: true }).waitFor();
        await page.keyboard.press('Escape');
      }
      for (const label of ['渲染', '源码']) {
        if (!(await page.getByRole('button', { name: label, exact: true }).isVisible()))
          await reader.locator('summary[title="更多文件操作"]').click();
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.keyboard.press('Escape');
        if (label === '渲染') await reader.locator('.cm-editor').waitFor();
        else await page.getByTestId('workspace-content-review-text').waitFor();
      }
    }
    await observeFirstFileQuote(page);
    openedReview = await assertNativeEntryReview(page, f, entry);
    if (extension === 'md' && shell === 'v2') {
      // The cold read still uses the real owner. Source/render switching remounts
      // its reference projection, whose loading row retires once the empty read
      // completes; select only after that announced loading phase has finished.
      await page.getByRole('region', { name: '引用消息 0', exact: true }).waitFor({ state: 'hidden' });
    }
    await quoteNative(page, extension, entry, f.phrases[0], '第一处改具体些。');
    await quoteNative(page, extension, entry, f.phrases[1], '第二处保留语气。');
    const preparePostCountBeforeSend = calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/prepare'),
    ).length;
    if (entry === 'file') assert.equal(preparePostCountBeforeSend, 0);
    else assert.ok(preparePostCountBeforeSend > 0);
    assert.deepEqual(f.owner.fileReviewStore.get(f.reviewId), openedReview);
    assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, f.tasksBefore);
    await page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-quoted.png` });
    await collapseV2Workspace(page);
    await page
      .getByRole('textbox', { name: '消息输入框', exact: true })
      .fill(`@${f.owner.catId} 请修改这两处引用，先给候选。`);
    const sentResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/messages' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: shell === 'v2' ? '发送消息' : 'Send message', exact: true }).click();
    assert.equal((await sentResponse).status(), 200);
    await page.getByTestId('context-annotations-summary').waitFor({ state: 'hidden' });
    assert.equal(f.sent.length, 1);
    const { message, input } = f.sent[0];
    assert.deepEqual(
      input.contextAttachments.map((quote) => quote.text),
      f.phrases,
    );
    assert.ok(
      input.contextAttachments.every(
        (quote) => quote.source.path === f.filePath && quote.source.revision === f.source.revision,
      ),
    );
    assert.deepEqual(f.owner.fileReviewStore.get(f.reviewId), openedReview);
    const record = await f.owner.takeOver(message.id);
    const prepared = f.owner.fileReviewStore.get(f.reviewId);
    if (openedReview) assert.deepEqual(prepared, openedReview, 'takeover reuses the current review without refresh');
    assert.equal(prepared.revision, 1);
    assert.deepEqual(prepared.annotations, []);
    assert.equal(record.payload.source.reviewId, f.reviewId);
    assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, f.tasksBefore + 1);
    const candidate = await f.candidate(record, message);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const drawer = page.getByTestId('contextual-workspace-host');
    if (width < 768 && (await drawer.isVisible())) {
      await collapseV2Workspace(page);
    }
    await page
      .locator(`[data-message-id="${candidate.receipt.id}"]`)
      .getByRole('button', { name: '打开对照', exact: true })
      .click();
    const result = page.locator(`[data-candidate-ref="${candidate.returned.proposalRef}"]`);
    await result.waitFor({ state: 'visible' });
    assert.equal(await result.locator('[data-text-edit]').count(), 2);
    await page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-candidate.png` });
    await result.getByTestId('content-modification-accept').click();
    await result.getByText('已写回原文件', { exact: true }).waitFor();
    assert.equal(await readFile(f.absolute, 'utf8'), candidate.written);
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/accept') && call.status === 200).length,
      1,
    );
    await page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-applied.png` });
    await page
      .getByTestId('workspace-content-review-surface')
      .getByRole('button', { name: '‹ 聊天', exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, `/thread/${f.owner.thread.id}`);
    await page.locator(`[data-message-id="${candidate.receipt.id}"]`).waitFor({ state: 'visible' });
    assert.deepEqual(session.errors, []);
    assert.deepEqual(f.owner.errors, []);
    await writeFile(
      `${EVIDENCE}/first-file-${slug}.json`,
      JSON.stringify(
        {
          testedHead: process.env.F309_TESTED_HEAD,
          scenario,
          filePath: f.filePath,
          sourceRevision: f.source.revision,
          reviewId: f.reviewId,
          sourceMessageId: message.id,
          requestId: record.requestId,
          taskId: record.progress.task.taskId,
          candidateRef: candidate.returned.proposalRef,
          preOpenReview: null,
          preSendReview: openedReview,
          preTakeoverReview: openedReview,
          preparePostCountBeforeSend,
          reviewCreatedByCallback: entry === 'file',
          nativeSend: input,
          actualModelInvocation: false,
          alphaAcceptance: false,
          boundaries: [
            'synthetic Human/session issuer consumes actual native POST with production schema',
            'explicit target mention enforced by issuer; AgentRouter excluded',
            'deterministic non-LLM provider',
            'unrelated shell catalog mocked',
            'production GET history reload; push transport excluded',
          ],
          calls,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await session?.page.screenshot({ path: `${EVIDENCE}/first-file-${slug}-failed.png` });
    if (session)
      await writeFile(
        `${EVIDENCE}/first-file-${slug}-failed.json`,
        JSON.stringify(
          {
            testedHead: process.env.F309_TESTED_HEAD,
            scenario,
            error: String(error),
            calls: session.calls,
            errors: session.errors,
            nativeSend: f.sent,
            body: (await session.page.locator('body').innerText()).slice(-10000),
            quoteTrace: await session.page.evaluate(() => window.__firstFileQuoteTrace ?? []),
          },
          null,
          2,
        ),
      );
    throw error;
  } finally {
    await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
    await session?.context.close();
    await f.close();
  }
}

async function assertLongMarkdownTail(suite, scenario) {
  const f = await createFirstFileFixture('md', { longMarkdown: true });
  let session;
  await mkdir(EVIDENCE, { recursive: true });
  try {
    session = await openDocumentSession(suite, f.owner, scenario);
    const { page } = session;
    const tools = await openWorkspaceTools(page);
    await tools.locator('[data-workspace-destination="surface:files"]').click();
    await page.getByTestId('f307-files-owner-surface').waitFor();
    const search = page.getByPlaceholder('搜索当前工作区…', { exact: true });
    await search.fill(f.filename);
    await search.press('Enter');
    await page.locator(`[data-search-result-path=${JSON.stringify(f.filePath)}][data-search-result-line="0"]`).click();
    const paper = page.getByTestId('workspace-content-review-text');
    await paper.waitFor();
    const geometry = await paper.evaluate(async (element, tailText) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const tail = [...element.querySelectorAll('p')].find((node) => node.textContent === tailText);
      const surface = element.closest('[data-testid="workspace-content-review-surface"]');
      const summary = element.parentElement.querySelector('section');
      if (!tail || !surface || !summary) throw new Error('Original reader, summary and final line must be mounted');
      const tailBox = tail.getBoundingClientRect();
      return {
        summaryHeight: summary.getBoundingClientRect().height,
        paperBottom: element.getBoundingClientRect().bottom,
        surfaceBottom: surface.getBoundingClientRect().bottom,
        visibleTop: Math.max(element.getBoundingClientRect().top, surface.getBoundingClientRect().top),
        visibleBottom: Math.min(element.getBoundingClientRect().bottom, surface.getBoundingClientRect().bottom),
        tailTop: tailBox.top,
        tailBottom: tailBox.bottom,
        scrollTop: element.scrollTop,
        maxScrollTop: element.scrollHeight - element.clientHeight,
      };
    }, f.tailText);
    await writeFile(
      `${EVIDENCE}/markdown-tail-${scenario.width}.json`,
      JSON.stringify({ testedHead: process.env.F309_TESTED_HEAD, scenario, geometry }, null, 2),
    );
    await page.screenshot({ path: `${EVIDENCE}/markdown-tail-${scenario.width}.png` });
    assert.ok(geometry.summaryHeight > 0, 'the original quote summary occupies its normal-flow space');
    assert.ok(geometry.maxScrollTop > 0, 'the document requires scrolling');
    assert.ok(Math.abs(geometry.scrollTop - geometry.maxScrollTop) <= 1, 'the paper has reached its scroll end');
    assert.ok(geometry.tailTop >= geometry.visibleTop - 1, 'the final line starts inside the visible reader');
    assert.ok(geometry.tailBottom <= geometry.visibleBottom + 1, 'the final line remains visible at the scroll end');
    const rangeBox = await paper.getByText(f.tailText, { exact: true }).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, y: box.top + box.height / 2 };
    });
    await page.mouse.move(rangeBox.left + 0.1, rangeBox.y);
    await page.mouse.down();
    await page.mouse.move(rangeBox.right + 0.1, rangeBox.y, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), f.tailText);
    assert.equal(f.sent.length, 0, 'reading and selecting the tail does not send a message');
    assert.equal(f.owner.tasks.listByThread(f.owner.thread.id).length, f.tasksBefore);
    assert.deepEqual(session.errors, []);
  } finally {
    await session?.context.unrouteAll({ behavior: 'ignoreErrors' });
    await session?.context.close();
    await f.close();
  }
}

export function registerFirstFileJourney(suite) {
  for (const scenario of [
    { width: 1440, dark: false, shell: 'v2' },
    { width: 390, dark: true, shell: 'v2' },
  ]) {
    test(`first file: long Markdown tail stays visible ${scenario.width}`, { timeout: 120_000 }, () =>
      assertLongMarkdownTail(suite, scenario),
    );
  }
  for (const scenario of [
    { extension: 'md', width: 1440, dark: false, shell: 'v2', entry: 'artwork' },
    { extension: 'md', width: 390, dark: true, shell: 'v2', entry: 'artwork' },
    { extension: 'ts', width: 390, dark: true, shell: 'v2', entry: 'file' },
  ]) {
    const { extension, width, shell, entry } = scenario;
    const slug = `${extension}-${width}-${shell}`;
    test(
      `first file: native ${entry === 'artwork' ? 'default artwork' : 'unprepared'} ${slug} quotes → Human send → takeover → candidate → explicit CAS`,
      { timeout: 120_000 },
      () => runFirstFileJourney(suite, scenario),
    );
  }
}
