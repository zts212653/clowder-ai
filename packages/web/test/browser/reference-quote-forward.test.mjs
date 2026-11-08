import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectMarkdownReadableText } from '@cat-cafe/shared';
import { chromium } from 'playwright';
import { build } from 'vite';
import { createCardSelectionApiFixture } from './card-selection-api-fixture.mjs';
import { mouseSelectReference } from './reference-quote-mouse.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url));
const origin = 'https://reference-quote.test';
const normalize = (text) => text.trim().replace(/\s+/gu, ' ');
const prefix = '前面的过程记录。\n\n';
// Original failure's path paragraph, followed by the other presentation substitutions.
const content =
  '我看到 `cat_cafe_propose_taste` 提到品味卡片保存在 `docs/taste/vignettes/` 或 `private/taste/`。我现在检查这两个目录下的品味文件，并查找 `packages/api/src/`。\n\n请 @codex61-sol 核对 [**品味**原文](docs/taste/notes.md) 和 https://example.com/details 。';
const answer = '请 @codex61-sol 检查 `docs/taste/vignettes/` 后回复。';
const scenarios = [
  { content, expected: content },
  { content: prefix + answer, expected: answer, native: true, start: prefix.length },
  { content: '检查 [说明文档](docs/hover-file.md) 后回复。', expected: '检查 说明文档', mouse: 'prefix' },
  { content: '检查 [原始文档](docs/hover-label.md) 后回复。', expected: '原始文档', mouse: 'label' },
  { content: '检查 [原始说明](docs/feedback.md) 后回复。', expected: '原始说明', mouse: 'label-feedback' },
  {
    content: '检查 `docs/probe-file.md` 和 `docs/report.pdf`。',
    expected: '检查 docs/probe-file.md 和 docs/report.pdf。',
    mouse: 'sentence',
  },
  {
    content: prefix + '请检查 `docs/selected.pdf` 后回复。',
    expected: 'docs/selected.pdf',
    native: true,
    start: prefix.length + '请检查 `'.length,
    mouse: 'label',
  },
  {
    content: '请查看 [工作说明](https://github.com/owner/repo/pull/6756) 后回复。',
    expected: '请查看 工作说明 后回复。',
    mouse: 'github-sentence',
  },
];
const cats = [
  {
    id: 'codex61-sol',
    displayName: '缅因猫 Sol',
    mentionPatterns: ['@sol'],
    carrier: 'cli',
    clientId: 'openai',
    defaultModel: 'test',
    avatar: '',
    color: { primary: '#000', secondary: '#fff' },
  },
];

function referenceTarget(reference) {
  if (reference.startsWith('https://github.com/'))
    return {
      kind: 'github',
      repo: 'owner/repo',
      number: 6756,
      objectType: 'pull',
      title: 'Real work',
      state: 'merged',
      url: reference,
      worktreeId: 'project',
    };
  if (!reference.includes('/')) return null;
  return {
    kind: 'file',
    entryType: reference.endsWith('/') ? 'directory' : 'file',
    worktreeId: 'project',
    path: reference,
    absolutePath: `/fixture/${reference}`,
    line: null,
    mime: 'text/plain',
    size: 42,
    modifiedAt: '2026-11-06T00:00:00Z',
  };
}

test(
  'rendered reference quotes reach the actual bundle writer and hydrate as original content',
  { timeout: 120000 },
  async (t) => {
    const fixture = await createCardSelectionApiFixture();
    t.after(() => fixture.app.close());
    const messages = scenarios.map((scenario, index) => {
      const stored = fixture.messageStore.append({
        threadId: fixture.sourceThread.id,
        userId: fixture.userId,
        from: { kind: 'agent', catId: 'codex' },
        content: scenario.content,
        mentions: [],
        timestamp: 1794000000000 + index * 1000,
        origin: 'callback',
        extra: { isExplicitPost: true },
      });
      return { ...stored, type: 'assistant', catId: 'codex' };
    });
    const data = {
      source: fixture.sourceThread,
      target: fixture.targetThread,
      messages,
      cats,
      nativeStart: prefix.length,
      nativeMessageIds: messages.filter((_, index) => scenarios[index].native).map((message) => message.id),
    };
    const previousCwd = process.cwd();
    let compiled;
    try {
      process.chdir(web); // Product Tailwind globs are relative to the Web workspace.
      compiled = await build({
        root: web,
        configFile: false,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        resolve: { alias: { '@': path.join(web, 'src') } },
        define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: path.join(web, 'test/browser/fixtures/reference-quote-forward.tsx'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
    } finally {
      process.chdir(previousCwd);
    }
    const outputs = Array.isArray(compiled) ? compiled.flatMap((item) => item.output) : compiled.output;
    const script = outputs.find((item) => item.type === 'chunk' && item.isEntry)?.code;
    assert.ok(script);
    const css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [],
      receipts = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, origin, 'the quote journey must not access a live service');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/api/workspace/chat-references') {
        const body = request.postDataJSON();
        return route.fulfill({
          json: {
            groups: body.groups.map((group) => ({
              ...group,
              results: group.references.map((reference) => ({
                reference,
                target: referenceTarget(reference),
              })),
            })),
          },
        });
      }
      if (url.pathname === '/api/workspace/file/actions/file-info') {
        const file = url.searchParams.get('path');
        return route.fulfill({
          json: {
            local: true,
            path: `/fixture/${file}`,
            filename: file.split('/').at(-1),
            byteLength: 42,
            mime: file.endsWith('.pdf') ? 'application/pdf' : 'text/markdown',
          },
        });
      }
      if (url.pathname.startsWith('/api/')) {
        const response = await fixture.app.inject({
          method: request.method(),
          url: url.pathname + url.search,
          ...(request.postData()
            ? { payload: request.postData(), headers: { 'content-type': 'application/json' } }
            : {}),
        });
        let body = response.body;
        if (url.pathname === '/api/cats')
          body = JSON.stringify({ ...response.json(), cats: [...response.json().cats, ...cats] });
        return route.fulfill({ status: response.statusCode, contentType: 'application/json', body });
      }
      assert.equal(url.pathname, '/');
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script id="fixture" type="application/json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script type="module" src="/proof.js"></script>`,
      });
    });
    await page.addInitScript(() => {
      // Keep the file-operation seam inside this isolated browser, away from the OS clipboard.
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } });
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    });
    await page.goto(origin);
    const evidence = process.env.REFERENCE_QUOTE_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const [index, scenario] of scenarios.entries()) {
      const { expected } = scenario;
      const source = page.locator(`[data-specimen="${index}"] [data-select-source]`);
      await source.locator('[data-chat-reference-kind]').first().waitFor();
      if (index < 2) assert.match(await source.innerText(), /@缅因猫 Sol/);
      const selectionProof = scenario.mouse
        ? await mouseSelectReference(page, source, scenario.mouse)
        : await source.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return {
              selected: selection.toString(),
              rendered: element.closest('[data-context-quote-source]').innerText,
            };
          });
      if (evidence)
        await writeFile(path.join(evidence, `selection-${index}.json`), JSON.stringify(selectionProof, null, 2));
      await page.getByTestId('message-selection-add-to-chat').click();
      const editor = page.getByTestId('context-annotation-editor');
      await editor.getByTestId('context-annotation-comment').fill('检查这段原文');
      if (evidence) await page.screenshot({ path: path.join(evidence, `quote-${index}.png`) });
      assert.equal(await editor.getByTestId('context-annotation-forward').count(), 1, JSON.stringify(selectionProof));
      await editor.getByTestId('context-annotation-forward').click();
      const picker = page.getByRole('dialog', { name: '转发到' });
      await picker.getByRole('button', { name: /接收测试对话/ }).click();
      await picker.locator('button[aria-pressed]').first().click();
      const responseReady = page.waitForResponse(
        (response) => response.url() === `${origin}/api/messages` && response.request().method() === 'POST',
      );
      await picker.getByRole('button', { name: '转发 1 段引用', exact: true }).click();
      const response = await responseReady;
      assert.equal(response.status(), 202, await response.text());
      const receipt = await response.json(),
        submitted = response.request().postDataJSON();
      const quote = submitted.messageBundle.items[0];
      assert.equal(normalize(quote.text), normalize(projectMarkdownReadableText(expected)));
      assert.equal(quote.renderedOccurrences, 1);
      if (scenario.native) assert.equal(quote.selectionStart, scenario.start);
      const hydrated = (await fixture.app.inject(`/api/message-bundles/${receipt.messageBundleId}`)).json();
      assert.equal(hydrated.targetThreadId, fixture.targetThread.id);
      assert.equal(normalize(hydrated.items[0].readableContent), normalize(projectMarkdownReadableText(expected)));
      assert.equal(hydrated.items[0].comment, '检查这段原文');
      receipts.push({ receipt, submitted, hydrated });
      // Provider execution is outside this fixture. Withdraw this case's own admitted work
      // after verifying the real writer/readback, rather than filling the five-entry Queue.
      const queued = fixture.queue.list(fixture.targetThread.id, fixture.userId);
      assert.equal(queued.length, 1);
      assert.ok(
        await fixture.queue.terminalizeEntryDurable(fixture.targetThread.id, fixture.userId, queued[0].id, 'cancelled'),
      );
      await picker.waitFor({ state: 'hidden' });
    }
    const forged = structuredClone(receipts[0].submitted);
    forged.idempotencyKey = 'd4e8940a-097b-4e53-b267-4e5c032b7b05';
    forged.messageBundle.items[0].text += '编造的内容';
    const beforeRejected = fixture.messageStore.getByThread(fixture.targetThread.id, 100).length;
    const rejected = await fixture.app.inject({ method: 'POST', url: '/api/messages', payload: forged });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().code, 'MESSAGE_BUNDLE_QUOTE_MISMATCH', JSON.stringify(rejected.json()));
    assert.equal(fixture.messageStore.getByThread(fixture.targetThread.id, 100).length, beforeRejected);
    assert.deepEqual(errors, []);
    if (evidence)
      await writeFile(
        path.join(evidence, 'receipts.json'),
        JSON.stringify({ receipts, rejected: rejected.json(), errors }, null, 2),
      );
  },
);
