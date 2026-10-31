import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startRealDocumentOwner } from './f309-ordinary-document-owner.mjs';
import { WEB_ROOT } from './f309-ordinary-workspace-journey-fixture.mjs';

/** Bounded read-only event/DOM probe; it never changes the app, selection or timing. */
export async function observeFirstFileQuote(page) {
  await page.evaluate(() => {
    const records = [];
    window.__firstFileQuoteTrace = records;
    const snapshot = (event, point) => {
      if (records.length >= 200) return;
      const editor = document.querySelector('[data-testid="context-annotation-comment"]');
      const card = document.querySelector('[data-testid="context-annotation-editor"]');
      const value = {
        event,
        time: performance.now(),
        editorId: editor?.id,
        value: editor?.value,
        quote: card?.querySelector('blockquote')?.textContent,
        active: document.activeElement?.getAttribute('data-testid'),
        draftSummary: document.querySelector('[data-testid="context-annotations-summary"]')?.textContent,
        ...(point
          ? {
              point,
              selection: window.getSelection()?.toString(),
              paragraphs: [...document.querySelectorAll('[data-testid="workspace-content-review-text"] p')].map(
                (p) => ({ text: p.textContent, rect: p.getBoundingClientRect().toJSON() }),
              ),
              containers: [
                ...document.querySelectorAll(
                  '[data-testid="workspace-content-review-text"], [data-testid="workspace-file-viewer"]',
                ),
              ].map((node) => ({
                id: node.dataset.testid,
                rect: node.getBoundingClientRect().toJSON(),
                scrollTop: node.scrollTop,
                ancestors: [
                  ...(function* () {
                    let p = node.parentElement;
                    for (let n = 0; p && n < 4; n++, p = p.parentElement) yield p;
                  })(),
                ].map((p) => ({
                  id: p.dataset.testid,
                  className: p.className,
                  rect: p.getBoundingClientRect().toJSON(),
                  scrollTop: p.scrollTop,
                  children: [...p.children].map((c) => ({
                    id: c.dataset.testid,
                    tag: c.tagName,
                    height: c.getBoundingClientRect().height,
                    text: c.textContent?.slice(0, 90),
                  })),
                })),
              })),
            }
          : {}),
      };
      records.push(value);
    };
    for (const type of ['mousedown', 'mousemove', 'mouseup'])
      document.addEventListener(
        type,
        (event) => {
          if (event.target?.closest?.('[data-testid="workspace-content-review-text"]'))
            snapshot(type, { x: event.clientX, y: event.clientY, target: event.target.tagName });
        },
        true,
      );
    for (const type of ['input', 'keydown', 'keyup', 'focusin', 'focusout'])
      document.addEventListener(
        type,
        (event) => {
          if (event.target?.matches?.('[data-testid="context-annotation-comment"]'))
            snapshot(`${type}:${event.key ?? ''}`);
        },
        true,
      );
    new MutationObserver(() => snapshot('DOM')).observe(document.body, { childList: true, subtree: true });
  });
}

/** No review, request, Task or Human source is seeded before the native file selection/send. */
export async function createFirstFileFixture(extension, { longMarkdown = false } = {}) {
  const evidence = await mkdtemp('/tmp/f309-first-file-native-');
  const owner = await startRealDocumentOwner(path.join(evidence, 'data'), { executionSource: 'human' });
  const filename = `f309-first-file-${randomUUID()}.${extension}`;
  const filePath = `packages/web/test/browser/fixtures/${filename}`;
  const absolute = path.resolve(WEB_ROOT, '../..', filePath);
  const phrases =
    extension === 'md'
      ? ['First unique paragraph.', 'Second unique paragraph.']
      : ['// First code phrase.', '// Second code phrase.'];
  const tailText = 'Final Markdown line.';
  const tail = longMarkdown
    ? `\n${Array.from({ length: 80 }, (_, index) => `Long document paragraph ${index + 1}.`).join('\n\n')}\n\n${tailText}\n`
    : '';
  const text =
    extension === 'md'
      ? `# First file\n\n${phrases[0]}\n\n${phrases[1]}\n${tail}`
      : `${phrases.join('\n')}\nexport const answer = 1;\n`;
  await writeFile(absolute, text, { flag: 'wx' });
  const listed = await (await fetch(`${owner.api}/api/workspace/worktrees`)).json();
  const worktree = listed.worktrees.find((work) => work.root === owner.root);
  assert.ok(worktree);
  const locator = { worktreeId: worktree.id, path: filePath };
  const source = await owner.workspaceSource.describe({ principal: { userId: 'operator' }, locator });
  const { workspaceReviewIdentity } = await import(
    '../../../api/dist/domains/collaborative-content/workspace-review/workspace-review-anchors.js'
  );
  const reviewId = workspaceReviewIdentity('operator', source.contentRef);
  assert.equal(owner.fileReviewStore.get(reviewId), null);
  const tasksBefore = owner.tasks.listByThread(owner.thread.id).length;
  const sent = [];
  async function captureNativeSend(context, expectedReview = () => null) {
    // The synthetic Human/session issuer consumes the real native POST and production schema.
    // AgentRouter and message push transport are explicitly outside this deterministic fixture.
    await context.route('**/api/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const { sendMessageSchema, buildMessageContentBlocks } = await import(
        '../../../api/dist/routes/messages.schema.js'
      );
      const input = sendMessageSchema.parse(route.request().postDataJSON());
      assert.equal(input.threadId, owner.thread.id);
      assert.ok(input.content.startsWith(`@${owner.catId} `));
      assert.equal(input.contextAttachments.length, 2);
      assert.deepEqual(
        owner.fileReviewStore.get(reviewId),
        expectedReview(),
        'quoting/sending preserves the review state established by the native entry',
      );
      const message = owner.messages.append({
        userId: 'operator',
        threadId: owner.thread.id,
        from: { kind: 'user', userId: 'operator' },
        mentions: [owner.catId],
        timestamp: Date.now(),
        content: input.content,
        contentBlocks: buildMessageContentBlocks(input.content, input.contextAttachments),
      });
      sent.push({ input, message });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'queued',
          userMessageId: message.id,
          threadId: owner.thread.id,
        }),
      });
    });
  }
  async function candidate(record, message) {
    const view = await owner.inspect(record.requestId);
    const edits = phrases.map((expectedText, index) => {
      const selection = record.payload.intent.selections.find((item) => item.selection.quote === expectedText);
      assert.ok(selection);
      return {
        selectionId: selection.id,
        start: text.indexOf(expectedText),
        end: text.indexOf(expectedText) + expectedText.length,
        expectedText,
        replacement: expectedText.replace(
          index === 0 ? 'First' : 'Second',
          index === 0 ? 'Revised first' : 'Revised second',
        ),
      };
    });
    const returned = await owner.callback('content-modification/respond', {
      requestId: record.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: view.taskRevision,
      expectedProposalRevision: view.proposalRevision,
      baseRevision: source.revision,
      edits,
      response: '两处引用的候选。',
    });
    assert.equal(await readFile(absolute, 'utf8'), text);
    const receipt = owner.messages
      .getByThread(owner.thread.id, 200)
      .find((item) => item.extra?.contentModificationReceiptV1?.candidateRef === returned.proposalRef);
    assert.ok(receipt);
    assert.equal(receipt.extra.contentModificationReceiptV1.sourceMessageId, message.id);
    return {
      returned,
      receipt,
      written: edits.reduce((bytes, edit) => bytes.replace(edit.expectedText, edit.replacement), text),
    };
  }
  return {
    owner,
    filename,
    filePath,
    absolute,
    phrases,
    tailText,
    text,
    source,
    reviewId,
    tasksBefore,
    sent,
    captureNativeSend,
    candidate,
    async close() {
      await owner.close();
      await rm(absolute);
      await rm(evidence, { recursive: true, force: true });
    },
  };
}
