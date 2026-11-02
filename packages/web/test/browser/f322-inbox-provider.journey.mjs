import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openProviderHost } from './f322-inbox-provider-host.fixture.mjs';

function providerRow(page, interactionId, kind) {
  // Approval Hub/runtime aliases collapse to the canonical approval identity; other provider requests retain their F306 key.
  const key =
    kind === 'approval' ? JSON.stringify(['F306', interactionId]) : `f306.runtime_interaction:${interactionId}`;
  return page.locator(`[data-testid="mailbox-item"][data-row-key='${key}']`);
}

/** The original provider, card and HTTP writer on both actual Next surfaces. */
export async function verifyProviderCards({ t, language, width, root }) {
  const evidence = path.join(root, 'provider', `${language}-${width}`);
  await mkdir(evidence, { recursive: true });
  const { f, entries, page, errors, posts, results, base } = await openProviderHost({ t, language, width, evidence });
  await page.goto(`${base}/thread/${f.conversationThread.id}?shell=v2`);
  const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
  await draft.fill('Unsent original provider verification draft');
  for (const entry of entries) {
    if (entry.surface === 'inbox' && !(await page.getByTestId('mailbox-close').isVisible()))
      await page.getByTestId('mailbox-button').click();
    const row = entry.surface === 'inbox' ? providerRow(page, entry.pending.request.interactionId, entry.kind) : null;
    const card = row
      ? row.getByTestId('runtime-interaction-card')
      : page.locator(
          `[data-rich-block-id="${entry.pending.cardRef.blockId}"] [data-testid="runtime-interaction-card"]`,
        );
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    if (!row) {
      const source = await f.messages.getById(entry.pending.cardRef.messageId);
      const rawPrefix = { approval: '需要你确认：', question: '需要你回答：', elicitation: '需要你补充：' }[
        entry.pending.request.kind
      ];
      const displayPrefix =
        language === 'en'
          ? { approval: 'Needs your approval: ', question: 'Needs your answer: ', elicitation: 'Needs your input: ' }[
              entry.pending.request.kind
            ]
          : rawPrefix;
      assert.equal(
        source.content,
        rawPrefix + entry.pending.request.title,
        'The original publisher still stores its original generated template',
      );
      const body = page.locator(`[data-message-id="${source.id}"] .markdown-content`).first();
      await body.getByText(displayPrefix + entry.pending.request.title, { exact: true }).waitFor();
      if (language === 'en') assert.ok(!(await body.innerText()).startsWith(rawPrefix));
      // Adopt this position through the history owner's real input path before framing the card.
      const port = await page.locator('[data-chat-container]').boundingBox();
      assert.ok(port);
      await page.mouse.move(port.x + 8, port.y + 24);
      await page.mouse.wheel(0, -1);
      await card.scrollIntoViewIfNeeded();
      // Pending forms may extend beyond the history viewport; their controls remain reachable by scrolling.
      // Playwright acts on visible controls below, and the settled/read-only elements are captured separately.
    }
    if (row) {
      assert.equal(await row.getAttribute('data-expanded'), 'false');
      const group = await row.evaluate((el) =>
        el.closest('section[data-testid^="mailbox-group-"]')?.getAttribute('data-testid'),
      );
      assert.equal(group, 'mailbox-group-decisions');
    }
    if (entry.kind === 'question') await card.locator('select[name="environment"]').selectOption('Alpha');
    if (entry.kind === 'form') {
      const accept = card.getByRole('button', { name: language === 'en' ? 'Allow once' : '允许一次', exact: true });
      assert.equal(await accept.isDisabled(), true);
      assert.equal(
        await card.getByRole('button', { name: language === 'en' ? 'Decline' : '拒绝', exact: true }).isEnabled(),
        true,
      );
      await card.locator('select[name="enabled"]').selectOption('false');
    }
    if (entry.kind === 'url') {
      const link = card.getByRole('link');
      assert.equal(await link.getAttribute('href'), 'https://example.invalid/authorize');
      assert.equal(await link.getAttribute('target'), '_blank');
    }
    const bounds = await card.evaluate((el) => el.getBoundingClientRect().toJSON());
    assert.ok(bounds.left >= 0 && bounds.right <= width + 1);
    await card.screenshot({ path: path.join(evidence, `${entry.surface}-${entry.kind}-before.png`) });
    const expected =
      entry.kind === 'question'
        ? { kind: 'answers', answers: { environment: ['Alpha'] } }
        : {
            kind: 'decision',
            decisionId: entry.kind === 'url' ? 'decline' : 'accept',
            ...(entry.kind === 'form' ? { content: { enabled: false } } : {}),
          };
    const buttonName =
      entry.kind === 'question'
        ? language === 'en'
          ? 'Submit answer'
          : '提交回答'
        : entry.kind === 'url'
          ? language === 'en'
            ? 'Decline'
            : '拒绝'
          : language === 'en'
            ? 'Allow once'
            : '允许一次';
    await card.getByRole('button', { name: buttonName, exact: true }).click();
    await entry.settled;
    assert.deepEqual(entry.result(), { response: expected });
    const terminal = await f.store.get(entry.pending.request.interactionId);
    assert.equal(terminal.status, entry.kind === 'url' ? 'declined' : 'answered');
    assert.equal(terminal.source.kind, 'provider_request');
    assert.equal(terminal.returnBinding.kind, 'provider_waiter');
    const posted = posts.filter((post) => post.path.includes(entry.pending.request.interactionId));
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { cardRef: entry.pending.cardRef, response: expected });
    const result = card.getByTestId('decision-result-row');
    await result.getByTestId('decision-result-label').waitFor();
    const label = await result.getByTestId('decision-result-label').innerText();
    assert.match(label, language === 'en' ? /^Chose “/ : /^已选「/);
    assert.match(
      label,
      entry.kind === 'question'
        ? /Alpha/
        : entry.kind === 'url'
          ? language === 'en'
            ? /Decline/
            : /拒绝/
          : language === 'en'
            ? /Allow once/
            : /允许一次/,
    );
    assert.equal(
      await result.getByTestId('decision-result-dot').getAttribute('data-status'),
      entry.kind === 'url' ? 'rejected' : 'approved',
    );
    if (entry.kind === 'question') {
      assert.match(label, /Alpha/);
      assert.deepEqual(terminal.terminal.response.selectedOptionIndexes, { environment: [0] });
      assert.equal(Object.hasOwn(terminal.terminal.response, 'answers'), false);
    }
    assert.equal(await result.getByTestId('decision-result-details').count(), 0);
    assert.equal(await result.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
    await card.screenshot({ path: path.join(evidence, `${entry.surface}-${entry.kind}-result.png`) });
    await result.locator('button[aria-expanded=false]').click();
    const details = result.getByTestId('decision-result-details');
    await details.waitFor();
    assert.equal(await details.locator('[data-selected] button, [data-selected] input').count(), 0);
    assert.equal(await details.locator('[data-selected=true]').count(), 1);
    assert.ok((await details.locator('[data-selected=true]').innerText()).includes('✓'));
    if (entry.kind === 'question')
      await details.getByText(entry.pending.request.questions[0].question, { exact: true }).waitFor();
    if (entry.kind === 'form' || entry.kind === 'url')
      await details.getByText(entry.pending.request.message, { exact: true }).waitFor();
    if (entry.kind === 'form')
      await details.getByText(language === 'en' ? 'Enabled' : '启用', { exact: true }).waitFor();
    assert.equal(await details.locator('input, select, textarea, form').count(), 0);
    if (entry.kind === 'url') assert.equal(await details.locator('a').count(), 0, 'Declined URL stays read-only');
    assert.equal(await result.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
    await card.screenshot({ path: path.join(evidence, `${entry.surface}-${entry.kind}-details.png`) });
    await result.locator('button[aria-expanded=true]').click();
    results.push({
      surface: entry.surface,
      kind: entry.kind,
      initial: entry.pending,
      terminal,
      expected,
      bounds,
      resultLabel: label,
      sourceMessage: await f.messages.getById(entry.pending.cardRef.messageId),
    });
  }
  assert.equal(posts.length, 8);
  if (await page.getByTestId('mailbox-close').isVisible()) await page.getByTestId('mailbox-close').click();
  await page.reload();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), 'Unsent original provider verification draft');
  for (const entry of entries) {
    const card = page.locator(
      `[data-rich-block-id="${entry.pending.cardRef.blockId}"] [data-testid="runtime-interaction-card"]`,
    );
    const terminalText =
      entry.kind === 'url'
        ? language === 'en'
          ? 'You declined this request.'
          : '你已拒绝这次请求。'
        : entry.kind === 'question'
          ? language === 'en'
            ? 'Answer submitted.'
            : '回答已提交。'
          : language === 'en'
            ? 'Request handled.'
            : '请求已处理。';
    await card.getByTestId('decision-result-label').waitFor();
    assert.equal(await card.getByTestId('decision-result-details').count(), 0);
    assert.equal(await card.locator('button').count(), 1, 'Only the result disclosure remains');
    await card.locator('button[aria-expanded=false]').click();
    const details = card.getByTestId('decision-result-details');
    await details.getByRole('heading', { name: entry.pending.request.title, exact: true }).waitFor();
    assert.equal(
      await details.getByText(terminalText, { exact: true }).count(),
      0,
      'The original request does not duplicate the terminal result',
    );
    assert.equal(await details.locator('[data-selected=true]').count(), 1);
    assert.equal(await details.locator('button').count(), 0, 'Disclosure must never restore a provider writer');
  }
  await page.getByTestId('mailbox-button').click();
  for (const entry of entries) {
    assert.equal(await providerRow(page, entry.pending.request.interactionId, entry.kind).count(), 0);
    const result = page.locator(
      `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify(['F306', entry.pending.request.interactionId])}']`,
    );
    await result.getByTestId('decision-result-label').waitFor();
    if (entry.kind === 'question') assert.match(await result.innerText(), /Alpha/);
    assert.equal(await result.getByTestId('decision-result-details').count(), 0);
    await result.locator('button[aria-expanded=false]').click();
    assert.equal(await result.locator('input,select,textarea,form').count(), 0);
    await result.screenshot({ path: path.join(evidence, `${entry.surface}-${entry.kind}-reloaded-inbox.png`) });
  }
  assert.equal((await f.store.readPendingIndexByUser('default-user')).records.length, 0);
  assert.deepEqual(f.queue.list(f.conversationThread.id, 'default-user'), []);
  assert.equal(f.mutations.filter((m) => m.path.endsWith('/messages') || m.path.includes('block-state')).length, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        language,
        width,
        results,
        posts,
        errors,
        boundary:
          'Actual original Next Chat and Inbox; approval/question/form/url with real private provider waiters and HTTP CAS. No live provider, Redis, Alpha or runtime claim.',
      },
      null,
      2,
    ),
  );
}
