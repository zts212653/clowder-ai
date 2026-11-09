/**
 * Issue #1863 — real product browser verification (exploratory, not formal product acceptance).
 *
 * Target: the real Next app at PRODUCT_BASE_URL (default http://127.0.0.1:4218),
 * backed by the real API/Redis stack. This script does NOT start a server, does NOT
 * intercept/fake API responses, and does NOT call a real model.
 *
 * The only "no model" guard is the empty-target send:
 *  - new conversation: / -> NewConversationPage (v2 ChatInput, threadId="default")
 *  - existing conversation: /thread/<threadId> -> ThreadChatSurface (v2 ChatInput)
 *  - no @mention, no recipient selection; before sending, the composer routing
 *    preview must still be "正在确认/Confirming". If it names a cat, the script
 *    refuses to send (Blocked) rather than risking a model call.
 *  - every POST body is checked for non-empty targetCats/targets/recipients.
 *
 * Run (after the stack is ready):
 *   PRODUCT_BASE_URL=http://127.0.0.1:4218 node packages/web/test/browser/issue1863-product-browser.mjs
 *
 * It writes test evidence to a fresh browser context and the isolated temp evidence directory.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const BASE = (process.env.PRODUCT_BASE_URL ?? 'http://127.0.0.1:4218').replace(/\/$/, '');
const HEAD = process.env.PRODUCT_HEAD ?? readHead();
const API = process.env.PRODUCT_API_URL ?? 'http://127.0.0.1:4219';
const evidence = path.join(os.tmpdir(), 'cat-cafe-evidence', 'issue1863-product', 'final');
await fs.mkdir(evidence, { recursive: true });
const LANG_KEY = 'cat-cafe:shell-language';
const SHELL_KEY = 'cat-cafe:shell-presentation';

const LINK = 'https://github.com/meow-club/cat-cafe-map';
const LINK_TEXT = `${LINK}这是链接`;
const LINK_SUFFIX = ' 这不是';
const NORMAL_TEXT = '说明 https://example.com 后';
const GAP_TEXT = '说明 https\\://example.com 后';
const GAP_TEXT_2 = '说明 https\\://a.example 后';
const GAP_TARGET = 'https://example.com/';
const GAP_TARGET_2 = 'https://a.example/';
const STANDALONE_ESCAPED = 'https\\://example.com';
const HISTORY_TEXT = 'alpha beta gamma';
const LONG_TEXT = Array.from(
  { length: 200 },
  (_, i) => `${i} https://example.com/${'very-long-path-'.repeat(3)}中文`,
).join(' ');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=';

class Blocked extends Error {}

const report = {
  head: HEAD,
  baseUrl: BASE,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  checks: [],
  failures: [],
  blocked: [],
  metrics: {},
  notes: [
    'No route interception and no fake persistence; all API calls are real.',
    'No model call is intentionally triggered: sends are refused unless the routing preview has no named recipient, and POST bodies are checked for target arrays.',
    'New conversation entry: / -> NewConversationPage (data-testid=new-conversation-page). Existing: /thread/<threadId> -> ThreadChatSurface (data-thread-chat-footer).',
    'The v2 shell is the default; this script pins cat-cafe:shell-presentation=v2 and cat-cafe:shell-language=zh via localStorage before navigation.',
    'The dev server must serve this feature checkout. Its embedded startup revision can precede HMR changes; report.head identifies the source checkout.',
    'With no configured accounts/recipients, message admission is real and durable, followed by an expected separate no_available_target system message; model-response behavior is outside this test.',
    'Image coverage is paste plus caption, submit, and reload. Baseline ChatInput.doSend does not admit an image-only draft; that unchanged limitation is not counted as passed.',
  ],
};

function readHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, message) {
  if (actual !== expected)
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function run(name, fn) {
  const entry = { name, status: 'running' };
  report.checks.push(entry);
  try {
    entry.detail = await fn();
    entry.status = 'pass';
  } catch (error) {
    if (error instanceof Blocked) {
      entry.status = 'blocked';
      entry.detail = error.message;
      report.blocked.push(name);
    } else {
      entry.status = 'fail';
      entry.error = error?.message ?? String(error);
      report.failures.push(name);
    }
  }
  console.log(entry.status + ': ' + name + (entry.error ? ' — ' + entry.error : ''));
  await fs.writeFile(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2));
}

const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(
  ({ langKey, shellKey }) => {
    try {
      localStorage.setItem(langKey, 'zh');
      localStorage.setItem(shellKey, 'v2');
    } catch {
      // The page is still usable if storage is unavailable; the assertions will report it.
    }
  },
  { langKey: LANG_KEY, shellKey: SHELL_KEY },
);
const page = await context.newPage();
report.linkFrames = [];
await page.exposeFunction('recordIssue1863Links', (frame) => report.linkFrames.push(frame));
await context.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    let previous = '';
    new MutationObserver(() => {
      const hrefs = Array.from(document.querySelectorAll('a[href*="github.com/meow-club/cat-cafe-map"]')).map(
        (node) => node.href,
      );
      const current = JSON.stringify(hrefs);
      if (current === previous) return;
      previous = current;
      window.recordIssue1863Links({ at: performance.now(), path: location.pathname, hrefs });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  });
});
const network = { posts: [], pageErrors: [] };
page.on('request', (request) => {
  if (request.method() !== 'POST') return;
  let body = null;
  try {
    body = request.postDataJSON();
  } catch {
    body = null;
  }
  network.posts.push({ url: request.url(), body });
});
page.on('pageerror', (error) => network.pageErrors.push(error.message));

let threadUrl = null;

async function composer() {
  const row = page.locator('[data-testid="chat-input-composer-row"]').last();
  await row.waitFor({ timeout: 30000 });
  const textarea = row.locator('textarea').first();
  await textarea.waitFor({ timeout: 15000 });
  return { row, textarea };
}

async function openNew() {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="new-conversation-page"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  return composer();
}

async function openThread(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-thread-chat-footer]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  return composer();
}

async function sendButton() {
  return page.getByRole('button', { name: /发送|Send message|^Send$/ }).last();
}

async function readRouting() {
  const preview = page.locator('[data-testid="composer-routing-preview"]').last();
  if ((await preview.count()) === 0) return { aria: '', text: '', empty: false };
  const aria = (await preview.getAttribute('aria-label')) ?? '';
  const name = page.locator('[data-testid="composer-routing-name"]').last();
  const text = ((await name.textContent()) ?? '').trim();
  const confirming = /正在确认|确认中|Confirming/i;
  return { aria, text, empty: confirming.test(text) || confirming.test(aria) };
}

async function clearTextarea(textarea) {
  await textarea.click();
  await textarea.press('Control+A');
  await textarea.press('Backspace');
  await page.waitForTimeout(150);
}

async function setComposer(textarea, value) {
  await textarea.click();
  await textarea.fill(value);
  await page.waitForTimeout(250);
}

async function marks() {
  return page.locator('[data-testid="composer-link-mirror"] mark').evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent ?? '',
      start: Number(node.dataset.linkStart),
      end: Number(node.dataset.linkEnd),
      href: node.dataset.linkHref ?? '',
      color: getComputedStyle(node).color,
    })),
  );
}

async function notice() {
  const node = page.locator('[data-testid="composer-link-notice"]');
  const count = await node.count();
  if (count === 0) return { count: 0, output: '', summary: '', codes: [] };
  return {
    count,
    output: ((await node.locator('output').first().textContent()) ?? '').trim(),
    summary: ((await node.locator('summary').first().textContent()) ?? '').trim(),
    codes: await node.locator('code').allTextContents(),
  };
}

async function linkByText(fragment) {
  const links = page.locator('a[href*="' + fragment + '"]');
  await links.last().waitFor({ timeout: 20000 });
  return {
    count: await links.count(),
    text: ((await links.last().textContent()) ?? '').trim(),
    href: (await links.last().getAttribute('href')) ?? '',
  };
}

async function assertSaved(source) {
  const id = new URL(page.url()).pathname.split('/thread/')[1];
  const response = await context.request.get(API + '/api/messages?threadId=' + encodeURIComponent(id));
  eq(response.status(), 200, 'real message readback status');
  const body = await response.json();
  const message = body.messages.find((item) => item.type === 'user' && item.content === source);
  ok(message, 'the real API must preserve the exact user source');
  eq(message.lifecycle.dispatchRefs.length, 0, 'no model dispatch');
  return { id: message.id, content: message.content, dispatchRefs: message.lifecycle.dispatchRefs };
}

function extractTargets(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  for (const key of ['targetCats', 'targets', 'recipients', 'explicitTargetCats']) {
    const value = body[key] ?? body.message?.[key];
    if (Array.isArray(value)) out.push(value);
  }
  return out;
}

async function sendAndWait(textarea, { viaEnter = false } = {}) {
  const routing = await readRouting();
  if (!routing.empty) {
    throw new Blocked(
      `recipient preview is not empty (${JSON.stringify(routing.text || routing.aria)}); refusing to send without a real empty-target path`,
    );
  }
  const before = network.posts.length;
  const button = viaEnter ? null : await sendButton();
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => /\/api\/messages$/.test(response.url()) && response.request().method() === 'POST',
    ),
    viaEnter ? textarea.press('Enter') : button.click(),
  ]);
  eq(response.status(), 202, 'real message admission status');
  const posts = network.posts.slice(before);
  const message = posts.find((post) => /\/messages(?:\?|$)/.test(post.url)) ?? posts[0] ?? null;
  const targets = message ? extractTargets(message.body) : [];
  if (targets.some((target) => target.length > 0)) {
    throw new Error(`non-empty target in client POST ${message?.url}: ${JSON.stringify(targets)}`);
  }
  return { posts, message, targets, status: response.status() };
}

async function waitForThread() {
  if (!/\/thread\//.test(new URL(page.url()).pathname)) {
    await page
      .waitForFunction(() => location.pathname.startsWith('/thread/'), null, { timeout: 20000 })
      .catch(() => {});
  }
  return page.url();
}

async function requireThread() {
  if (!threadUrl)
    throw new Blocked(
      'no thread URL: the new-conversation send did not complete, so the existing-thread checks cannot run',
    );
  return threadUrl;
}

async function pastePng(textarea) {
  await textarea.evaluate((node, base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'issue1863-pixel.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    node.dispatchEvent(event);
  }, PNG_1X1);
  await page.waitForTimeout(2500);
}

try {
  await run('preflight: new-conversation v2/zh and empty-target state', async () => {
    const c = await openNew();
    const routing = await readRouting();
    const preview = page.locator('[data-testid="composer-routing-preview"]').last();
    const aria = (await preview.getAttribute('aria-label')) ?? '';
    ok(/发给|Send to/.test(aria), `v2/zh routing preview not found; aria=${JSON.stringify(aria)}`);
    if (!routing.empty) {
      throw new Blocked(
        `routing preview already names a recipient (${JSON.stringify(routing.text || aria)}); no empty-target send attempted`,
      );
    }
    report.metrics.newConversation = { url: page.url(), routing: routing.text || aria };
    return { url: page.url(), routing: routing.text || aria, composer: await c.textarea.getAttribute('aria-label') };
  });

  await run('new conversation: blue source range, edit/undo, send, refresh', async () => {
    const c = await composer();
    await clearTextarea(c.textarea);
    await setComposer(c.textarea, LINK_TEXT);
    const initialMarks = await marks();
    ok(initialMarks.length === 1, `expected one blue source range, got ${JSON.stringify(initialMarks)}`);
    ok(
      initialMarks[0].text === LINK_TEXT,
      `expected the whole source range ${JSON.stringify(LINK_TEXT)}, got ${JSON.stringify(initialMarks[0].text)}`,
    );
    eq(initialMarks[0].color, 'rgb(37, 99, 235)', 'light link color');
    eq((await notice()).count, 0, 'normal link must not show the gap notice');
    await c.row.screenshot({ path: path.join(evidence, 'new-composer-blue.png') });

    await c.textarea.evaluate((node, offset) => node.setSelectionRange(offset, offset), LINK.length);
    await c.textarea.pressSequentially(' ', { delay: 0 });
    await page.waitForTimeout(250);
    const spaced = await marks();
    ok(
      spaced.some((mark) => mark.text === LINK),
      `typing a space after the URL should shrink the range to the URL: ${JSON.stringify(spaced)}`,
    );
    ok(!spaced.some((mark) => mark.text === LINK_TEXT), 'the old URL+Chinese range should be gone after the space');

    await c.textarea.press('Control+z');
    await page.waitForTimeout(250);
    const undone = await marks();
    ok(
      undone.some((mark) => mark.text === LINK_TEXT),
      `native undo should restore ${JSON.stringify(LINK_TEXT)}: ${JSON.stringify(undone)}`,
    );

    await clearTextarea(c.textarea);
    await setComposer(c.textarea, LINK_TEXT);
    const sent = await sendAndWait(c.textarea);
    threadUrl = await waitForThread();
    const current = new URL(threadUrl);
    ok(current.pathname.startsWith('/thread/'), `new conversation did not navigate to /thread/<id>; url=${threadUrl}`);
    const bubble = await linkByText('cat-cafe-map');
    eq(bubble.text, 'github.com', 'bubble keeps its hostname label');
    eq(bubble.href, new URL(LINK_TEXT).href, 'actual generated link target');
    const saved = await assertSaved(LINK_TEXT);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const afterReload = await linkByText('cat-cafe-map');
    ok(afterReload.count >= 1, 'sent link should survive a hard refresh');
    eq(afterReload.href, bubble.href, 'refresh keeps the same href');
    await assertSaved(LINK_TEXT);
    await page.screenshot({ path: path.join(evidence, 'thread-after-refresh.png') });
    return { threadUrl, post: sent.message?.url, href: bubble.href, afterReloadHref: afterReload.href, saved };
  });

  await run('existing conversation: second send and refresh', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    await clearTextarea(c.textarea);
    await setComposer(c.textarea, `${LINK_TEXT} 第二次`);
    const first = await marks();
    ok(first.length >= 1, `existing-thread composer should show a blue range: ${JSON.stringify(first)}`);
    await c.textarea.evaluate((node, offset) => node.setSelectionRange(offset, offset), LINK.length);
    await c.textarea.pressSequentially(' ');
    ok(
      (await marks()).some((mark) => mark.text === LINK),
      'existing-thread boundary edit shrinks the blue range',
    );
    await c.textarea.press('Control+z');
    eq(await c.textarea.inputValue(), LINK_TEXT + ' 第二次', 'existing-thread undo preserves the exact source');
    const sent = await sendAndWait(c.textarea);
    await page.waitForTimeout(1000);
    const links = page.locator('a[href*="cat-cafe-map"]');
    await page.waitForFunction(() => document.querySelectorAll('a[href*="cat-cafe-map"]').length >= 2);
    ok(
      (await links.count()) >= 2,
      `existing thread should now contain at least two sent links, got ${await links.count()}`,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const afterReload = page.locator('a[href*="cat-cafe-map"]');
    await page.waitForFunction(() => document.querySelectorAll('a[href*="cat-cafe-map"]').length >= 2);
    ok((await afterReload.count()) >= 2, `both links should survive refresh, got ${await afterReload.count()}`);
    const saved = await assertSaved(LINK_TEXT + ' 第二次');
    return { threadUrl: url, post: sent.message?.url, links: await afterReload.count(), saved };
  });

  await run('existing conversation: draft restore after reload', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    const draft = `draft-${Date.now()} https://example.com/草稿`;
    await clearTextarea(c.textarea);
    await setComposer(c.textarea, draft);
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (draft) =>
        Array.from(document.querySelectorAll('[data-testid="chat-input-composer-row"] textarea')).at(-1)?.value ===
        draft,
      draft,
    );
    const restoredComposer = await composer();
    const restored = await restoredComposer.textarea.inputValue();
    ok(
      restored.includes(draft),
      `draft should survive reload; expected ${JSON.stringify(draft)}, got ${JSON.stringify(restored)}`,
    );
    return { draft, restored };
  });

  await run('gap notice: target update and disappearance', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    await clearTextarea(c.textarea);
    await setComposer(c.textarea, GAP_TEXT);
    const gap = await notice();
    ok(gap.count === 1, `inline escaped URL should show the gap notice: ${JSON.stringify(gap)}`);
    ok(gap.output.includes('有链接未能标出'), `gap notice output: ${JSON.stringify(gap.output)}`);
    ok(
      gap.codes.includes(GAP_TARGET),
      `gap notice target list should include ${GAP_TARGET}: ${JSON.stringify(gap.codes)}`,
    );
    await page.locator('[data-testid="composer-link-notice"] summary').first().click();
    await page.waitForTimeout(150);
    await c.row.screenshot({ path: path.join(evidence, 'gap-targets.png') });

    await setComposer(c.textarea, GAP_TEXT_2);
    const gap2 = await notice();
    ok(
      gap2.count === 1 && gap2.codes.includes(GAP_TARGET_2),
      `gap target should update to ${GAP_TARGET_2}: ${JSON.stringify(gap2)}`,
    );

    await setComposer(c.textarea, NORMAL_TEXT);
    const fixed = await notice();
    eq(fixed.count, 0, 'gap notice should disappear for a normal URL');
    const normalMarks = await marks();
    ok(
      normalMarks.some((mark) => mark.text === 'https://example.com'),
      `normal URL should be marked: ${JSON.stringify(normalMarks)}`,
    );

    await setComposer(c.textarea, STANDALONE_ESCAPED);
    const standaloneNotice = await notice();
    eq(
      standaloneNotice.count,
      0,
      'a standalone decoded/escaped URL should be mapped to the whole source node, not shown as a gap',
    );
    const standaloneMarks = await marks();
    ok(
      standaloneMarks.some((mark) => mark.text === STANDALONE_ESCAPED),
      `standalone escaped source should be one source range: ${JSON.stringify(standaloneMarks)}`,
    );
    await setComposer(c.textarea, GAP_TEXT);
    await sendAndWait(c.textarea);
    const target = page.locator('a[href="https://example.com/"]');
    await target.last().waitFor({ timeout: 30000 });
    const saved = await assertSaved(GAP_TEXT);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await target.last().waitFor({ timeout: 30000 });
    eq((await notice()).count, 0, 'submitted draft clears its gap notice');
    return { initial: gap, updated: gap2, normal: normalMarks, standalone: standaloneMarks, saved };
  });

  await run('CDP composition: native color, cancellation and confirmation (not physical IME)', async () => {
    const c = await composer();
    await setComposer(c.textarea, LINK);
    await c.textarea.press('End');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '临时', selectionStart: 2, selectionEnd: 2 });
    eq(
      await page.locator('[data-testid="composer-link-mirror"]').getAttribute('data-active'),
      'false',
      'native color during composition',
    );
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    eq(await c.textarea.inputValue(), LINK, 'cancellation restores the committed source');
    eq(
      await page.locator('[data-testid="composer-link-mirror"]').getAttribute('data-active'),
      'true',
      'blue restored after cancellation',
    );
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '中文' });
    eq(await c.textarea.inputValue(), LINK + '中文', 'confirmed Chinese input remains intact');
    eq((await marks())[0]?.text, LINK + '中文', 'confirmed range follows current text');
    await cdp.detach();
    return { source: await c.textarea.inputValue(), physicalImeVerified: false };
  });

  await run('image paste: preview and send with empty target', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    await clearTextarea(c.textarea);
    await pastePng(c.textarea);
    const previews = await page.locator('img[src^="blob:"]').count();
    ok(previews > 0, 'pasted image should produce a blob preview in the composer');
    await setComposer(c.textarea, 'issue1863 pasted image');
    const sent = await sendAndWait(c.textarea);
    await page.waitForTimeout(1200);
    const bubbleImage = page.locator('img[src*="/uploads/"]').last();
    await bubbleImage.waitFor({ timeout: 20000 });
    ok((await bubbleImage.count()) > 0, 'sent image should render in the message bubble');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const afterReload = page.locator('img[src*="/uploads/"]');
    await afterReload.last().waitFor({ timeout: 30000 });
    ok((await afterReload.count()) > 0, 'sent image should survive refresh');
    return { threadUrl: url, post: sent.message?.url, previews, bubbleImages: await afterReload.count() };
  });

  await run('ghost suggestion: history completion and Tab acceptance', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    await clearTextarea(c.textarea);
    await setComposer(c.textarea, HISTORY_TEXT);
    await sendAndWait(c.textarea);
    await page.waitForTimeout(600);
    await clearTextarea(c.textarea);
    await c.textarea.pressSequentially('alpha b', { delay: 0 });
    await page.waitForTimeout(300);
    const ghost = page.locator('[data-testid="ghost-suggestion"]');
    if ((await ghost.count()) === 0) {
      throw new Blocked(
        'ghost suggestion did not appear for "alpha b"; the input history may not contain the sent message in this session',
      );
    }
    const ghostText = ((await ghost.textContent()) ?? '').trim();
    ok(
      ghostText.includes('eta gamma') || ghostText.includes('beta'),
      `ghost should complete toward ${JSON.stringify(HISTORY_TEXT)}: ${JSON.stringify(ghostText)}`,
    );
    await c.textarea.press('Tab');
    await page.waitForTimeout(200);
    const accepted = await c.textarea.inputValue();
    eq(accepted, HISTORY_TEXT, 'Tab should accept the history ghost');
    return { ghostText, accepted };
  });

  await run('mention completion opens and Escape preserves the draft', async () => {
    const c = await composer();
    await setComposer(c.textarea, '@');
    const options = page.locator('div.absolute.bottom-full.left-4 button');
    await options.first().waitFor();
    const count = await options.count();
    await c.textarea.press('Escape');
    eq(await options.count(), 0, 'Escape closes member completion');
    eq(await c.textarea.inputValue(), '@', 'completion cancellation preserves source');
    return { count };
  });

  await run('Enter semantics: Shift+Enter newline, Enter send', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    await clearTextarea(c.textarea);
    await c.textarea.pressSequentially('line1', { delay: 0 });
    await c.textarea.press('Shift+Enter');
    await c.textarea.pressSequentially('line2', { delay: 0 });
    const value = await c.textarea.inputValue();
    ok(value.includes('\n'), `Shift+Enter should insert a newline, got ${JSON.stringify(value)}`);
    const sent = await sendAndWait(c.textarea, { viaEnter: true });
    await page.waitForTimeout(1000);
    ok((await page.getByText('line1', { exact: false }).count()) > 0, 'sent line1 should appear in the thread');
    ok((await page.getByText('line2', { exact: false }).count()) > 0, 'sent line2 should appear in the thread');
    return { value, post: sent.message?.url };
  });

  await run('long draft: actual typing latency and blue range', async () => {
    const url = await requireThread();
    const c = await openThread(url);
    await clearTextarea(c.textarea);
    await c.textarea.fill(LONG_TEXT);
    await c.textarea.evaluate((node) => {
      window.issue1863PaintDelays = [];
      node.addEventListener('input', () => {
        const started = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.issue1863PaintDelays.push(performance.now() - started)),
        );
      });
    });
    const started = Date.now();
    const appended = 'input-response-'.repeat(4);
    await c.textarea.pressSequentially(appended, { delay: 5, timeout: 180000 });
    const elapsedMs = Date.now() - started;
    const value = await c.textarea.inputValue();
    const longMarks = await marks();
    eq(value, LONG_TEXT + appended, 'native typing preserves a long mixed-language draft');
    ok(longMarks.length > 0, 'long draft should still have blue ranges');
    ok(elapsedMs < 120000, `long draft typing took ${elapsedMs}ms (>=120s); this is a real latency finding`);
    report.metrics.longDraft = {
      chars: value.length,
      paintDelaysMs: await page.evaluate(() => window.issue1863PaintDelays),
      typedChars: appended.length,
      boundary:
        'Native keys on a long dev-mode draft; paint delays span the input event to two animation frames, wall time also includes Playwright overhead. Not a hardware latency benchmark.',
      ms: elapsedMs,
      msPerTypedChar: Number((elapsedMs / appended.length).toFixed(2)),
      ranges: longMarks.length,
    };
    return report.metrics.longDraft;
  });

  await run('empty-target and no-model audit', async () => {
    const targeted = [];
    for (const post of network.posts) {
      const arrays = extractTargets(post.body);
      if (arrays.some((value) => value.length > 0)) targeted.push({ url: post.url, arrays });
    }
    ok(targeted.length === 0, `client POSTs contained non-empty target arrays: ${JSON.stringify(targeted)}`);
    ok(network.pageErrors.length === 0, `page errors: ${JSON.stringify(network.pageErrors)}`);
    return { posts: network.posts.length, targets: targeted, pageErrors: network.pageErrors.length };
  });
} finally {
  report.finishedAt = new Date().toISOString();
  report.pageErrors = network.pageErrors;
  report.network = {
    posts: network.posts.map((post) => ({ url: post.url, targetArrays: extractTargets(post.body) })),
  };
  report.threadUrl = threadUrl;
  report.ok = report.failures.length === 0 && report.blocked.length === 0;
  report.exitCode = report.failures.length > 0 ? 1 : report.blocked.length > 0 ? 2 : 0;
  await fs.writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  process.exitCode = report.exitCode;
}
