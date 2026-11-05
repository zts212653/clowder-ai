import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readbackResponse, startNativeHost } from './f322-native-reply-next.mjs';

// The 2026-10-16 runtime failure coordinates and wire shape. Source prose is replaced;
// the canonical from/agent envelope, refs-only carrier and route are preserved.
const trace = { threadId: 'thread_mvbje7lnq7fpskjw', userId: 'default-user' };
const sourceId = '0001792203819936-003232-840a5e7e';
const bundleId = '0001792204537314-003272-c8ce0d81';
const sourceThreadId = 'thread-bundle-source';
const message = {
  id: bundleId,
  type: 'user',
  from: { kind: 'user', userId: trace.userId },
  content: '转发了 1 条聊天记录',
  timestamp: 1792204537314,
  extra: { messageBundle: { v: 1, sourceThreadId, items: [{ kind: 'message', messageId: sourceId }] } },
};
const projection = {
  messageBundleId: bundleId,
  targetThreadId: trace.threadId,
  createdBy: trace.userId,
  createdAt: message.timestamp,
  sourceThread: { id: sourceThreadId, title: 'Bundle source conversation' },
  items: [
    {
      status: 'available',
      kind: 'message',
      messageId: sourceId,
      sourceThreadId,
      from: { kind: 'agent', catId: 'gemini-argon' },
      timestamp: 1792203819936,
      readableContent: 'Original sandbox reply remains readable after forwarding.',
    },
  ],
};

export async function runMessageBundleNextJourney(browser, evidenceDir) {
  const host = await startNativeHost();
  const evidence = [];
  try {
    await host.ready();
    for (const shell of ['v2', 'classic']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        await context.addInitScript((shell) => {
          localStorage.setItem('cat-cafe:shell-presentation', shell);
          localStorage.setItem('cat-cafe:shell-language', 'zh');
          localStorage.setItem('theme', 'light');
        }, shell);
        const page = await context.newPage();
        const errors = [];
        let reads = 0;
        let malformed = false;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/api/**', async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (pathname === `/api/message-bundles/${bundleId}`) {
            reads += 1;
            const body = malformed
              ? { ...projection, items: [{ ...projection.items[0], from: undefined }] }
              : projection;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            return;
          }
          const response = readbackResponse(request, trace, message);
          await route.fulfill({
            status: response.status ?? 200,
            contentType: 'application/json',
            body: JSON.stringify(response.body),
          });
        });
        const url = `${host.url}/thread/${trace.threadId}?shell=${shell}`;
        await page.goto(url, { waitUntil: 'networkidle' });
        const card = page.locator(`[data-message-bundle-id="${bundleId}"]`);
        await card.getByText(projection.items[0].readableContent, { exact: true }).waitFor();
        assert.match(await card.innerText(), /gemini-argon/);
        assert.ok(reads > 0, 'the native route must hydrate the refs-only carrier');
        await page.reload({ waitUntil: 'networkidle' });
        await card.getByText(projection.items[0].readableContent, { exact: true }).waitFor();
        assert.ok(reads >= 2, 'cold history reopens the same carrier through the API');
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true });
          await page.screenshot({ path: path.join(evidenceDir, `message-bundle-${shell}.png`) });
        }

        malformed = true;
        await page.reload({ waitUntil: 'networkidle' });
        const row = page.locator(`[data-message-id="${bundleId}"]`).last();
        await row.getByRole('alert').waitFor();
        assert.equal(await card.count(), 0, 'a malformed read does not leave old source content');
        assert.deepEqual(errors, [], 'bad data stays inside the bundle read error, never a page crash');
        if (evidenceDir)
          await page.screenshot({ path: path.join(evidenceDir, `message-bundle-${shell}-read-error.png`) });
        malformed = false;
        await row.getByRole('button', { name: '重试', exact: true }).click();
        await card.getByText(projection.items[0].readableContent, { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        evidence.push({ shell, url, reads, pageErrors: errors, historyReload: 'passed', malformedRetry: 'passed' });
      } finally {
        await context.close();
      }
    }
  } finally {
    await host.close();
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, 'message-bundle-native.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }
}
