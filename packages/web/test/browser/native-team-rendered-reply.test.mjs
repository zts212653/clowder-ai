import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { waitForRenderedHistory, waitForRenderedReply } from './native-team-rendered-reply.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
async function withPage(html, action) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await action(page);
  } finally {
    await page.close();
  }
}
test('a persisted assistant reply may carry its normal identity signature', () =>
  withPage(
    '<div data-message-id="user-1">LIVE_TOKEN</div><div data-message-id="reply-1"><div data-testid="message-bubble">LIVE_TOKEN [砚砚/GPT-6🐾]</div></div>',
    (page) => waitForRenderedReply(page, 'reply-1', 'LIVE_TOKEN', { timeout: 1000 }),
  ));
test('a user echo cannot stand in for the actual assistant message', () =>
  withPage(
    '<div data-message-id="user-1">LIVE_TOKEN</div><div data-message-id="reply-1"><div data-testid="message-bubble">尚无回复</div></div>',
    (page) => assert.rejects(waitForRenderedReply(page, 'reply-1', 'LIVE_TOKEN', { timeout: 200 })),
  ));
test('another assistant or a hidden reply cannot satisfy this persisted message identity', async () => {
  for (const html of [
    '<div data-message-id="other-reply"><div data-testid="message-bubble">LIVE_TOKEN</div></div><div data-message-id="reply-1"><div data-testid="message-bubble">其他回复</div></div>',
    '<div data-message-id="reply-1" style="display:none"><div data-testid="message-bubble">LIVE_TOKEN</div></div>',
  ])
    await withPage(html, (page) =>
      assert.rejects(waitForRenderedReply(page, 'reply-1', 'LIVE_TOKEN', { timeout: 200 })),
    );
});

test('a quoted user marker in the assistant header cannot stand in for its reply body', () =>
  withPage(
    '<div data-message-id="reply-1"><header>co-creator: LIVE_TOKEN</header><div data-testid="message-bubble">尚无回复</div></div>',
    (page) => assert.rejects(waitForRenderedReply(page, 'reply-1', 'LIVE_TOKEN', { timeout: 200 })),
  ));

test('restored Markdown uses actual rendered output, including disclosure, instead of raw source', () =>
  withPage(
    '<article data-message-id="reply-1"><div data-testid="message-bubble"><p>收到结果。</p><div hidden><strong>审核结果</strong><code>A2A_PEER_ab12=121</code><code>A2A_FINAL_ab12=121</code></div><button data-reading-disclosure onclick="this.previousElementSibling.hidden=false;this.textContent=\'收起\'">展开（还有 5 行）</button></div></article>',
    async (page) => {
      const proof = await waitForRenderedHistory(
        page,
        { id: 'reply-1', content: '收到结果。\n\n**审核结果**：`A2A_PEER_ab12=121`\n`A2A_FINAL_ab12=121`' },
        { timeout: 500 },
      );
      assert.equal(proof.anchors.length, 2);
      assert.equal(await page.getByRole('button').innerText(), '收起');
    },
  ));

test('a greeting or another message cannot replace a retained result after Markdown rendering', async () => {
  for (const body of ['收到结果。', '收到结果。<code>A2A_FINAL_ab12=120</code>'])
    await withPage(
      `<article data-message-id="other"><div data-testid="message-bubble">A2A_FINAL_ab12=121</div></article><article data-message-id="reply-1"><header>A2A_FINAL_ab12=121</header><div data-testid="message-bubble">${body}</div></article>`,
      (page) =>
        assert.rejects(
          waitForRenderedHistory(
            page,
            { id: 'reply-1', content: '收到结果。\n**交付**：`A2A_FINAL_ab12=121`' },
            { timeout: 200 },
          ),
        ),
    );
});

test('plain failed outcomes remain readable; unsupported rich-only fixtures cannot pass as nonempty', async () => {
  await withPage(
    '<article data-message-id="reply-1"><div data-testid="message-bubble">收到。</div></article>',
    (page) => waitForRenderedHistory(page, { id: 'reply-1', content: '收到。' }, { timeout: 500 }),
  );
  await withPage(
    '<article data-message-id="reply-1"><div data-testid="message-bubble">任意回复</div></article>',
    (page) =>
      assert.rejects(
        waitForRenderedHistory(page, { id: 'reply-1', content: '**原始结果**' }, { timeout: 200 }),
        /explicit rendered-content expectation/,
      ),
  );
});
