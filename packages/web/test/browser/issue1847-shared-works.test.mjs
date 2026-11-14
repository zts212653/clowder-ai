import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildChatProof, origin, webRoot } from './fixtures/f322-chat-real-page-build.mjs';

const built = await buildChatProof('issue1847-works-page.tsx');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext();
const page = await context.newPage();
const requests = [],
  errors = [],
  unexpected = [];
let version = 1,
  titled = false,
  release;
const titleReady = new Promise((resolve) => {
  release = resolve;
});
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/')
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
  if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
  if (url.pathname === '/api/session') return json({ userId: 'owner', csrfToken: 'isolated-csrf' });
  if (url.pathname === '/api/cats') return json({ cats: [] });
  if (url.pathname === '/api/config/cat-order') return json({ catOrder: [] });
  if (url.pathname === '/uploads/new.md')
    return route.fulfill({ contentType: 'text/markdown', body: '# New work\nSynthetic browser acceptance material.' });
  if (url.pathname.endsWith('/artifacts')) {
    requests.push(url.pathname);
    const empty = url.pathname.includes('works-b');
    const artifacts = empty
      ? []
      : [
          {
            type: 'pr',
            ref: 'org/repo#12',
            name: titled ? 'Stored PR title' : 'org/repo#12',
            catId: 'codex',
            createdAt: 1,
            sourceMessageId: null,
          },
          ...(version === 2
            ? [
                {
                  type: 'file',
                  name: 'New work.md',
                  url: '/uploads/new.md',
                  catId: 'codex',
                  createdAt: 2,
                  sourceMessageId: 'stream',
                },
              ]
            : []),
        ];
    return json({ view: 'works', artifacts, total: artifacts.length, complete: true, workLineage: 'resolved' });
  }
  if (url.pathname.endsWith('/github/pr-title')) {
    requests.push('background-title');
    await titleReady;
    titled = true;
    return json({ title: 'Stored PR title' });
  }
  if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  unexpected.push(url.pathname);
  return route.fulfill({ status: 404, body: '' });
});
const reads = () => requests.filter((value) => value.endsWith('/artifacts')).length;
try {
  await page.goto(origin);
  await page.getByTestId('header-works').filter({ hasText: '1' }).waitFor();
  await page.getByText('org/repo#12').first().waitFor();
  assert.equal(reads(), 1);
  release();
  await page.getByText('Stored PR title').first().waitFor();
  assert.equal(requests.filter((value) => value === 'background-title').length, 1);
  assert.equal(reads(), 1);
  await page.getByRole('button', { name: 'Stream text', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(reads(), 1);
  await page.getByRole('button', { name: 'Finish message', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(reads(), 1, 'a plain message ending does not publish work');
  await page.getByRole('button', { name: 'Review elsewhere', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(reads(), 1, 'unscoped review updates do not invalidate Works');
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/artifacts')),
    page.getByRole('button', { name: 'Finish invocation', exact: true }).click(),
  ]);
  assert.equal(reads(), 2, 'one invocation terminal refresh is shared by all three consumers');
  version = 2;
  await page.getByRole('button', { name: 'Publish work', exact: true }).click();
  await page.getByTestId('header-works').filter({ hasText: '2' }).waitFor();
  assert.equal(reads(), 3);
  await page.getByRole('button', { name: 'Switch thread', exact: true }).click();
  await page.getByTestId('header-works').filter({ hasText: '0' }).waitFor();
  assert.equal(reads(), 4);
  await page.getByRole('button', { name: 'Old thread changed', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(reads(), 4);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  const evidence = path.resolve(webRoot, '../../artifacts/issue1847-browser');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, 'report.json'),
    JSON.stringify(
      {
        requests,
        errors,
        unexpected,
        initialReads: 1,
        materialReads: 1,
        streamedTextReads: 0,
        messageEndReads: 0,
        invocationEndReads: 1,
        reviewEventReads: 0,
        backgroundTitleLookups: 1,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      initialReads: 1,
      materialReads: 1,
      streamedTextReads: 0,
      messageEndReads: 0,
      invocationEndReads: 1,
      reviewEventReads: 0,
      backgroundTitleLookups: 1,
      threadSwitchReads: 1,
      oldThreadReads: 0,
      errors,
    }),
  );
} finally {
  release();
  await browser.close();
}
