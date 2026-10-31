import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { modelProjection } from './f309-ordinary-workspace-journey-text-quote.mjs';

/** Native decision button → sole Chat → one intercepted send. API routing/takeover is verified separately. */
export async function verifyTaskRequestChange({ page, surface, owner, view, sent, label, evidence }) {
  const cats = await fetch(`${owner.apiOrigin}/api/cats`).then((response) => response.json());
  const registeredOwner = cats.cats.find((cat) => cat.id === view.authority.ownerCatId);
  assert.ok(registeredOwner?.mentionPatterns.length);
  const mention = `@${registeredOwner.mentionPatterns[0].replace(/^@/, '')}`;
  const composer = page.getByLabel('消息输入框');
  const words = 'ABCDEFGHIJKL';
  const expectedTitle = await surface.locator('h2').innerText();
  if (process.env.F309_REQUEST_CHANGE_SELECTION_TRACE === '1') await installSelectionTrace(page);
  await composer.fill(words);
  await composer.click();
  await composer.press('Home');
  for (let i = 0; i < 8; i++) await composer.press('ArrowRight');
  for (let i = 0; i < 5; i++) await composer.press('Shift+ArrowLeft');
  const selection = () =>
    composer.evaluate((input) => [input.selectionStart, input.selectionEnd, input.selectionDirection]);
  assert.deepEqual(await selection(), [3, 8, 'backward']);
  assert.equal(await page.locator('textarea:visible').count(), 1);
  await surface.getByRole('button', { name: '要求修改', exact: true }).click();
  await page.waitForFunction(
    (mention) => document.querySelector('[aria-label="消息输入框"]')?.value.includes(mention),
    mention,
  );
  assert.equal(await composer.inputValue(), `${words}\n${mention}`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await selection(), [3, 8, 'backward']);
  const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
  await chip.waitFor();
  assert.match(await chip.innerText(), new RegExp(expectedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(sent.length, 0, 'requesting changes prepares the original Chat without sending');
  await page.screenshot({ path: `${evidence}/${label}-original-composer.png` });
  await surface.getByRole('button', { name: '对比版本', exact: true }).click();
  // Establish the person's real selection again in the comparison consumer before its handoff.
  // Opening comparison is a separate native action; its old inactive DOM range is not the precondition.
  await composer.click();
  await composer.press('Home');
  await composer.press('ArrowUp');
  await composer.press('Home');
  for (let i = 0; i < 8; i++) await composer.press('ArrowRight');
  for (let i = 0; i < 5; i++) await composer.press('Shift+ArrowLeft');
  assert.deepEqual(await selection(), [3, 8, 'backward']);
  await page.getByTestId('artifact-media-compare').getByRole('button', { name: '要求修改', exact: true }).click();
  assert.equal(
    await composer.inputValue(),
    `${words}\n${mention}`,
    'repeating from comparison does not duplicate the target',
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await selection(), [3, 8, 'backward']);
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]')?.value === '');
  assert.equal(sent.length, 1);
  const [payload] = sent;
  await writeFile(`${evidence}/${label}-observed-send.json`, `${JSON.stringify({ view, sent }, null, 2)}\n`);
  assert.equal(payload.content, `${words}\n${mention}`);
  assert.equal(payload.contextAttachments.length, 1);
  const [reference] = payload.contextAttachments;
  assert.equal(reference.title, expectedTitle);
  assert.deepEqual(reference.selections, []);
  assert.equal(reference.taskContext.taskId, owner.taskId);
  assert.equal(reference.taskContext.reviewId, view.review.reviewId);
  assert.equal(reference.taskContext.round, 2);
  assert.equal(reference.taskContext.expectedReviewRevision, view.review.revision);
  assert.equal(reference.taskContext.expectedTaskRevision, view.authority.taskRevision);
  const round = view.review.rounds.at(-1);
  if (round.ledgerRef && round.ledgerRevision) {
    assert.deepEqual(reference.source, {
      kind: 'publication',
      contentRef: round.asset.contentRef,
      ownerRevision: round.asset.ownerRevision,
      ledgerRef: round.ledgerRef,
      expectedLedgerRevision: round.ledgerRevision,
    });
  } else {
    assert.deepEqual(reference.source, {
      kind: 'artifact-review',
      reviewId: view.review.reviewId,
      round: round.number,
      expectedReviewRevision: view.review.revision,
    });
  }
  await modelProjection(payload); // The intercepted original body passes the canonical API schema and prompt projection.
  await writeFile(
    `${evidence}/${label}.json`,
    `${JSON.stringify({ url: page.url(), scope: 'real Next/native input; controlled send, no model', expectedTitle, registeredOwner: { id: registeredOwner.id, mention }, selection: [3, 8, 'backward'], sent }, null, 2)}\n`,
  );
}

/** Diagnostic only: preserve the native setter/event behavior while recording which commit moves the selection. */
async function installSelectionTrace(page) {
  await page.evaluate(() => {
    const trace = [];
    window.requestChangeSelectionTrace = trace;
    const ids = new WeakMap();
    let serial = 0;
    const record = (kind, detail) => {
      const input = document.querySelector('[aria-label="消息输入框"]');
      if (input && !ids.has(input)) ids.set(input, ++serial);
      trace.push({
        at: performance.now(),
        kind,
        detail,
        inputId: input ? ids.get(input) : null,
        value: input?.value,
        selection: input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null,
        focused:
          document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 40),
      });
    };
    const original = HTMLTextAreaElement.prototype.setSelectionRange;
    HTMLTextAreaElement.prototype.setSelectionRange = function (...args) {
      record('setSelectionRange:before', { args, stack: new Error().stack });
      const result = original.apply(this, args);
      record('setSelectionRange:after');
      return result;
    };
    for (const key of ['value', 'defaultValue', 'selectionStart', 'selectionEnd', 'selectionDirection']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, key);
      Object.defineProperty(HTMLTextAreaElement.prototype, key, {
        ...descriptor,
        set(value) {
          record(`${key}:before`, { value, stack: new Error().stack?.split('\n').slice(0, 7) });
          descriptor.set.call(this, value);
          record(`${key}:after`);
        },
      });
    }
    for (const key of ['removeAllRanges', 'collapse', 'setBaseAndExtent']) {
      const original = Selection.prototype[key];
      Selection.prototype[key] = function (...args) {
        record(`Selection.${key}`, { stack: new Error().stack?.split('\n').slice(0, 7) });
        return original.apply(this, args);
      };
    }
    for (const kind of ['pointerdown', 'click', 'focusin', 'focusout', 'select', 'selectionchange', 'input'])
      document.addEventListener(
        kind,
        (event) =>
          record(kind, {
            target: event.target?.getAttribute?.('aria-label') ?? event.target?.textContent?.slice(0, 40),
          }),
        true,
      );
    record('installed');
  });
}
