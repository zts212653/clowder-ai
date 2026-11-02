import assert from 'node:assert/strict';
import { fulfillFixtureApi } from './f309-ordinary-workspace-journey-actions.mjs';
import { assertThemeApplied } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { createReviewState } from './f309-ordinary-workspace-journey-fixture.mjs';

/** Production history/owner projection; session, provider and unrelated shell configuration remain test boundaries. */
export async function openDocumentSession(
  suite,
  owner,
  { width = 1440, dark = false, shell = 'classic', beforeNavigate } = {},
) {
  const context = await suite().browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(
    (theme) => {
      localStorage.setItem('theme', theme);
    },
    dark ? 'dark' : 'light',
  );
  const calls = [],
    errors = [];
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (value) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (
      url.pathname.startsWith('/api/workspace/') ||
      url.pathname.startsWith('/api/content-modifications') ||
      (owner.nativeMediaRoutes &&
        (url.pathname.startsWith('/api/content-publications/') ||
          url.pathname.startsWith('/api/content-reviews/') ||
          url.pathname.startsWith('/api/artifact-reviews/') ||
          url.pathname.startsWith('/api/messages/') ||
          url.pathname === `/api/threads/${owner.thread.id}/artifacts` ||
          url.pathname === '/api/artifacts')) ||
      url.pathname === '/api/messages'
    ) {
      const upstream = `${owner.api}${url.pathname}${url.search}`;
      const response = await route.fetch({ url: upstream });
      calls.push({
        method: request.method(),
        path: url.pathname,
        status: response.status(),
        upstream,
        body: await response.json().catch(() => null),
      });
      if (url.pathname === '/api/workspace/worktrees') {
        const value = await response.json();
        value.worktrees = value.worktrees.filter((work) => work.root === owner.root);
        assert.equal(value.worktrees.length, 1);
        return route.fulfill({ response, json: value });
      }
      return route.fulfill({ response });
    }
    if (url.pathname === '/api/threads') return json({ threads: [owner.thread] });
    if (url.pathname === `/api/threads/${owner.thread.id}`) return json(owner.thread);
    if (url.pathname === '/api/cats') {
      const { catRegistry } = await import('../../../shared/dist/index.js');
      return json({ cats: Object.values(catRegistry.getAllConfigs()).map((cat) => ({ ...cat, id: cat.id })) });
    }
    return fulfillFixtureApi(route, createReviewState(), []);
  });
  if (owner.nativeMediaRoutes)
    await context.route('**/uploads/*', async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${owner.api}${url.pathname}` });
      return route.fulfill({ response });
    });
  await beforeNavigate?.(context, calls);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const url = new URL(suite().baseUrl);
  url.pathname = `/thread/${owner.thread.id}`;
  url.searchParams.set('shell', shell);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-chat-container]').waitFor({ timeout: 30_000 });
  await page.waitForFunction((value) => (document.documentElement.dataset.shell ?? 'classic') === value, shell);
  await assertThemeApplied(page, dark);
  return { page, context, calls, errors };
}
