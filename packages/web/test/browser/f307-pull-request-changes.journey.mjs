import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createPullRequestReadFixture } from './f307-pull-request-changes.fixture.mjs';
import { realSurfaceApiResponse, THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

function recordCardOrigin() {
  document.addEventListener(
    'click',
    (event) => {
      const card = event.target.closest('[data-home-artifact-id]');
      const home = card?.closest('[data-testid="f307-workspace-home-page"]');
      if (card && home)
        window.__prCardOrigin = {
          artifactId: card.getAttribute('data-home-artifact-id'),
          offset: card.getBoundingClientRect().top - home.getBoundingClientRect().top,
        };
    },
    { capture: true },
  );
}

async function resizeWorkspace(page, width) {
  const home = page.getByTestId('f307-workspace-home-page');
  const separator = page.getByRole('separator', { name: '右侧面板分隔条', exact: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await home.boundingBox();
    assert.ok(box);
    if (Math.abs(box.width - width) <= 2) return;
    const handle = await separator.boundingBox();
    assert.ok(handle, 'Resize through the original Workspace control');
    const x = handle.x + handle.width / 2;
    const y = handle.y + Math.min(handle.height / 2, 120);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width - width, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  assert.ok(Math.abs((await home.boundingBox()).width - width) <= 2, `Workspace width must be ${width}`);
}

async function run(getSuite, width, language) {
  const { browser, baseUrl, evidenceDir } = getSuite();
  const backend = await createPullRequestReadFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ({ language }) => {
      if (window.top !== window || sessionStorage.getItem('pr-read-initialized')) return;
      sessionStorage.setItem('pr-read-initialized', '1');
      localStorage.clear();
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', language);
    },
    { language },
  );
  const page = await context.newPage();
  const errors = [];
  const reads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const artifact = (number) => ({
    type: 'pr',
    name: `Exact card PR ${number}`,
    ref: `Owner/Repo#${number}`,
    catId: 'codex61-sol',
    createdAt: number,
    sourceMessageId: null,
  });
  const cards = [artifact(7), artifact(8)];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/workspace/pull-request-changes') {
      const result = await backend.read(url.href);
      reads.push({ url: url.pathname + url.search, status: result.status, body: JSON.parse(result.body) });
      return route.fulfill(result);
    }
    let response = realSurfaceApiResponse(request, false);
    if (url.pathname === `/api/threads/${THREAD_ID}/artifacts`)
      response = {
        body: {
          threadId: THREAD_ID,
          artifacts: cards,
          ...(url.searchParams.get('view') === 'works'
            ? { view: 'works', complete: true, total: cards.length, workLineage: 'resolved' }
            : {}),
        },
      };
    if (url.pathname === '/api/artifacts')
      response = {
        body: {
          artifacts: cards.map((a) => ({ ...a, threadId: THREAD_ID, threadTitle: 'Native PR source' })),
          total: cards.length,
          ...(url.searchParams.get('view') === 'works'
            ? { view: 'works', complete: true, workLineage: 'resolved' }
            : {}),
        },
      };
    if (url.pathname === '/api/workspace/diff')
      response = {
        body: {
          changedFiles: [{ path: 'local.ts', status: 'M' }],
          diff: 'diff --git a/local.ts b/local.ts\n--- a/local.ts\n+++ b/local.ts\n@@ -1 +1 @@\n-before\n+LOCAL WORKTREE ONLY',
        },
      };
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  const name = `pr-changes-${width}-${language}`;
  try {
    await page.goto(baseUrl);
    await ensureWorkspaceOpen(page);
    await resizeWorkspace(page, width);
    const host = page.getByTestId('f307-experience-workbench');
    const home = page.getByTestId('f307-workspace-home-page');
    const homeBox = await home.boundingBox();
    assert.ok(homeBox && Math.abs(homeBox.width - width) <= 3, 'the real Workspace uses the original resized column');
    const draft = page.locator('[data-guide-id="chat.input"] textarea');
    await draft.fill(`PR draft ${width}`);
    const card = home.getByTestId('workspace-home-artifact-card').filter({ hasText: cards[0].name });
    await card.waitFor({ state: 'visible' });
    await page.evaluate(recordCardOrigin);
    if (width === 288) await card.press('Enter');
    else await card.click();
    const origin = await page.evaluate(() => window.__prCardOrigin);
    assert.ok(origin?.artifactId && Number.isFinite(origin.offset));
    const status = host.locator('[data-testid="pull-request-changes-status"]:visible');
    await status.getByText('owner/repo#7', { exact: true }).waitFor();
    await host.getByRole('cell', { name: /^\+\s*exact-pr-7$/ }).waitFor();
    assert.match(await status.innerText(), /仅显示部分变更|Showing partial changes/);
    assert.equal(await host.getByRole('cell', { name: /^\+\s*LOCAL WORKTREE ONLY$/ }).count(), 0);
    assert.equal(await host.getByTestId('native-review-workspace-strip').count(), 0);
    const deleted = host.getByRole('button').filter({ hasText: 'bar.ts' });
    await deleted.waitFor();
    assert.match(await deleted.innerText(), /−1/);
    await deleted.click();
    await host.getByRole('cell', { name: /^-\s*space-path-delete-7$/ }).waitFor();
    await host.getByText('src/foo b/bar.ts', { exact: true }).waitFor();
    assert.equal(await host.getByText('No parseable diff hunks found', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidenceDir, `${name}-deleted-space-path.png`) });
    await deleted.click();

    const sourceSurface = await host.getAttribute('data-active-surface');
    await page.screenshot({ path: path.join(evidenceDir, `${name}-read.png`) });
    await page.reload();
    await status.getByTestId('changes-origin-back').waitFor({ state: 'visible' });
    await host.getByRole('cell', { name: /^\+\s*exact-pr-7$/ }).waitFor();
    assert.equal(await host.getAttribute('data-active-surface'), sourceSurface);
    backend.setUnavailable(true);
    await page.reload();
    await status.getByRole('alert').waitFor();
    assert.match(await status.getByRole('alert').innerText(), /请求受限|rate limit/);
    assert.equal(await host.getByRole('cell', { name: /^\+\s*LOCAL WORKTREE ONLY$/ }).count(), 0);
    await page.screenshot({ path: path.join(evidenceDir, `${name}-unavailable.png`) });
    await status.getByTestId('changes-origin-back').click();
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction((source) => {
      const home = document.querySelector('[data-testid="f307-workspace-home-page"]');
      const card = Array.from(home?.querySelectorAll('[data-home-artifact-id]') ?? []).find(
        (node) => node.getAttribute('data-home-artifact-id') === source.artifactId,
      );
      return (
        card?.getAttribute('aria-current') === 'true' &&
        Math.abs(card.getBoundingClientRect().top - home.getBoundingClientRect().top - source.offset) <= 2
      );
    }, origin);
    assert.equal(await draft.inputValue(), `PR draft ${width}`);
    await page.screenshot({ path: path.join(evidenceDir, `${name}-back.png`) });
    backend.setUnavailable(false);
    await home.locator('section[aria-labelledby="home-works-title"] .home-all').click();
    const row = host
      .getByTestId('v2-works-panel')
      .getByTestId('workspace-home-artifact-card')
      .filter({ hasText: cards[1].name });
    await row.waitFor();
    await row.press('Enter');
    await status.getByText('owner/repo#8', { exact: true }).waitFor();
    await host.getByRole('cell', { name: /^\+\s*exact-pr-8$/ }).waitFor();
    await status.getByTestId('changes-origin-back').click();
    await row.waitFor({ state: 'visible' });
    assert.equal(await draft.inputValue(), `PR draft ${width}`);
    assert.ok(reads.some((r) => r.status === 200 && r.body.target.prNumber === 7));
    assert.ok(reads.some((r) => r.status === 200 && r.body.target.prNumber === 8));
    assert.ok(
      reads.every((r) => r.status !== 200 || r.body.comparison.headSha === String(r.body.target.prNumber).repeat(40)),
    );
    assert.ok(
      backend.calls.every(
        ({ args }) => !args.some((a) => ['fetch', 'checkout', 'stash', 'diff', 'status'].includes(a)),
      ),
    );
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(evidenceDir, `${name}.json`),
      JSON.stringify({ origin, sourceSurface, reads, backendCalls: backend.calls, errors }, null, 2),
    );
  } catch (error) {
    await page.screenshot({ path: path.join(evidenceDir, `${name}-failed.png`) }).catch(() => undefined);
    await writeFile(
      path.join(evidenceDir, `${name}-failed.json`),
      JSON.stringify({ errors, reads, backendCalls: backend.calls, failure: String(error) }, null, 2),
    );
    throw error;
  } finally {
    await context.close();
    await backend.close();
  }
}

export function registerPullRequestChangesJourneys(getSuite) {
  for (const [width, language] of [
    [288, 'zh'],
    [480, 'en'],
  ]) {
    test(
      `exact PR changes use the real read owner and return to Home/list at ${width}px ${language}`,
      { timeout: 120_000 },
      () => run(getSuite, width, language),
    );
  }
}
