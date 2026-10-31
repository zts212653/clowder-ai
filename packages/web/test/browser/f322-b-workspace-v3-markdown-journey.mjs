import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { WORKSPACE_BINARY_FILES, WORKSPACE_MARKDOWN_BODY } from './f322-b-workspace-v3-file-fixture.mjs';
import {
  createWorkspaceV3Fixture,
  WORKSPACE_SAMPLE_MARKDOWN,
  WORKSPACE_SAMPLE_PUBLISHED_TEXT,
  WORKSPACE_SAMPLE_THREAD,
} from './f322-b-workspace-v3-fixture.mjs';

async function openPublishedTextFromHome(page, home, fixture, parameters, evidenceDir, name) {
  fixture.setArtifacts(
    fixture.artifacts.map((artifact) =>
      artifact === WORKSPACE_SAMPLE_MARKDOWN ? WORKSPACE_SAMPLE_PUBLISHED_TEXT : artifact,
    ),
  );
  await page.route(`**${WORKSPACE_SAMPLE_PUBLISHED_TEXT.url}`, (route) => fixture.answer(route));
  await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  const card = home
    .getByTestId('workspace-home-artifact-card')
    .filter({ hasText: WORKSPACE_SAMPLE_PUBLISHED_TEXT.name });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  assert.doesNotMatch(await card.innerText(), /Unknown version|版本未知/);
  const key = await card.getAttribute('data-home-artifact-id');
  assert.ok(key);
  const callsBefore = fixture.calls.length;
  await card.press('Enter');
  const reader = page
    .getByRole('article', { name: WORKSPACE_SAMPLE_PUBLISHED_TEXT.name, exact: true })
    .getByTestId('workspace-file-viewer');
  await reader.getByRole('heading', { name: 'F322 published Markdown', exact: true }).waitFor();
  const original = await reader.elementHandle();
  const en = parameters.language === 'en';
  await reader.getByText(en ? 'Read only' : '只读', { exact: true }).waitFor();
  for (const label of en ? ['Source', 'Rendered'] : ['源码', '渲染'])
    await reader.getByRole('button', { name: label, exact: true }).press('Enter');
  await reader.getByText('Original published words.', { exact: true }).waitFor();
  assert.equal(await reader.evaluate((element, previous) => element === previous, original), true);
  assert.equal(await page.locator('[data-testid="workspace-file-viewer"]:visible').count(), 1);
  assert.equal(
    await reader.getByRole('button', { name: /^(编辑|请猫修改|采用并写回|Edit|Ask cat to modify)$/ }).count(),
    0,
  );
  await page.screenshot({ path: `${evidenceDir}/${name}-published-reader.png` });
  await reader.getByRole('button', { name: en ? 'Back to source' : '返回来源', exact: true }).press('Enter');
  await home.waitFor();
  assert.equal(await card.getAttribute('data-home-artifact-id'), key);
  assert.equal(await card.getAttribute('aria-current'), 'true');
  const newCalls = fixture.calls.slice(callsBefore);
  assert.ok(newCalls.some((call) => call.path === WORKSPACE_SAMPLE_PUBLISHED_TEXT.url && call.method === 'GET'));
  assert.equal(
    newCalls.some((call) => /^\/api\/(workspace\/|content-reviews|content-publications)/.test(call.path)),
    false,
    'A publication copy does not invent a writable file locator or publication owner',
  );
}

async function openBinaryCardsFromHome(page, home, fixture, parameters, evidenceDir, name) {
  const artifacts = WORKSPACE_BINARY_FILES.map((sample) =>
    fixture.artifacts.find((artifact) => artifact.url === sample.url),
  );
  for (const [index, sample] of WORKSPACE_BINARY_FILES.entries()) {
    const artifact = artifacts[index];
    assert.ok(artifact);
    fixture.setArtifacts([artifact]);
    await page.route(`**${sample.url}`, (route) => fixture.answer(route));
    await page.evaluate(() => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
    const card = home.getByTestId('workspace-home-artifact-card').filter({ hasText: sample.name });
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    assert.doesNotMatch(await card.innerText(), /Unknown version|版本未知/);
    const key = await card.getAttribute('data-home-artifact-id');
    const entry = card.locator('..');
    await entry.locator('summary').press('Enter');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      entry.getByRole('link', { name: parameters.language === 'en' ? 'Download' : '下载', exact: true }).press('Enter'),
    ]);
    assert.equal(download.suggestedFilename(), sample.name);
    const downloaded = `${evidenceDir}/${name}-${sample.file}`;
    await download.saveAs(downloaded);
    assert.deepEqual(await readFile(downloaded), sample.bytes);
    assert.equal(await home.isVisible(), true, 'Original Home download does not open another reader');
    await card.press('Enter');
    const owner = page.getByRole('article', { name: sample.name, exact: true });
    await owner
      .getByText(
        parameters.language === 'en' ? 'This file type cannot be previewed in this panel' : '此类型无法在面板内预览',
        { exact: true },
      )
      .waitFor();
    assert.ok(
      (
        await owner
          .getByRole('link', { name: parameters.language === 'en' ? 'Download' : '下载', exact: true })
          .getAttribute('href')
      ).endsWith(sample.url),
    );
    assert.equal(await page.locator('[data-testid="workspace-file-viewer"]:visible').count(), 0);
    await page.screenshot({ path: `${evidenceDir}/${name}-${sample.file}-owner.png` });
    await owner
      .getByRole('button', { name: parameters.language === 'en' ? 'Back' : '返回', exact: true })
      .press('Enter');
    await home.waitFor();
    assert.equal(await card.getAttribute('data-home-artifact-id'), key);
    assert.equal(await card.getAttribute('aria-current'), 'true');
  }
}

export function registerWorkspaceMarkdownJourneys(getSuite, resizeWorkspace, evidenceDir) {
  for (const parameters of [
    { width: 288, language: 'zh', theme: 'light' },
    { width: 480, language: 'en', theme: 'dark' },
  ])
    test(`F322 B Workspace v3 Markdown Home card ${parameters.width}/${parameters.language}/${parameters.theme}`, async () => {
      const { browser, baseUrl } = getSuite();
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const fixture = createWorkspaceV3Fixture();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.addInitScript(({ language, theme }) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', theme);
      }, parameters);
      await page.route('**/api/**', (route) => fixture.answer(route));
      await page.route('**/uploads/f322-controlled-*.png', (route) => fixture.answer(route));
      const name = `md-${parameters.width}-${parameters.language}-${parameters.theme}`;
      try {
        await page.goto(new URL(`/thread/${WORKSPACE_SAMPLE_THREAD}`, baseUrl).href, { waitUntil: 'domcontentloaded' });
        await ensureWorkspaceOpen(page);
        const home = page.getByTestId('f307-workspace-home-page');
        await home.waitFor();
        await resizeWorkspace(page, parameters.width);
        const card = home
          .getByTestId('workspace-home-artifact-card')
          .filter({ hasText: WORKSPACE_SAMPLE_MARKDOWN.name });
        await card.scrollIntoViewIfNeeded();
        assert.doesNotMatch(await card.innerText(), /Unknown version|版本未知/);
        const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
        await composer.fill('MD 原 Chat 草稿与选择位置');
        await composer.evaluate((input) => input.setSelectionRange(3, 8));
        await card.press('Enter');
        await page.getByText('打开的是你现在选定的文件，不代表已找回历史原件。', { exact: true }).waitFor();
        await page.getByRole('button', { name: '在 F322 controlled workspace 继续', exact: true }).press('Enter');
        const reader = page.getByTestId('workspace-file-viewer');
        await reader.waitFor();
        const paper = page.getByTestId('workspace-content-review-text');
        await paper.getByRole('heading', { name: 'F322 controlled Markdown', exact: true }).waitFor();
        assert.equal(await page.getByTestId('workspace-content-review-text').count(), 1);
        assert.equal(await page.getByRole('button', { name: '文件工具', exact: true }).count(), 0);
        const originalReader = await reader.elementHandle();
        for (const label of ['渲染', '源码']) {
          const toggle = page.getByRole('button', { name: label, exact: true });
          if (!(await toggle.isVisible())) await reader.locator('summary[title="更多文件操作"]').click();
          await toggle.press('Enter');
        }
        await paper.getByRole('heading', { name: 'F322 controlled Markdown', exact: true }).waitFor();
        assert.equal(await reader.evaluate((element, original) => element === original, originalReader), true);
        const selection = fixture.calls.find((call) => call.path === '/api/workspace/resolve-file-source');
        assert.ok(selection, 'Original file-location owner receives the explicit selection');
        assert.deepEqual(JSON.parse(selection.body), {
          selectedRoot: '/project/cat-cafe',
          selectionEpoch: 1,
          path: WORKSPACE_SAMPLE_MARKDOWN.ref,
          expectedUserId: 'f322-sample-user',
        });
        const preparation = fixture.calls.find((call) => call.path === '/api/workspace/content-reviews/prepare');
        assert.deepEqual(JSON.parse(preparation.body).locator, fixture.file.source.locator);
        assert.ok((await paper.innerText()).includes(WORKSPACE_MARKDOWN_BODY.split('\n')[2]));
        await page.screenshot({ path: `${evidenceDir}/${name}-reader.png` });
        await page.getByTestId('v2-file-back').click();
        await home.waitFor();
        assert.equal(await card.getAttribute('aria-current'), 'true');
        await openPublishedTextFromHome(page, home, fixture, parameters, evidenceDir, name);
        await openBinaryCardsFromHome(page, home, fixture, parameters, evidenceDir, name);
        assert.equal(await composer.inputValue(), 'MD 原 Chat 草稿与选择位置');
        assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
        assert.equal(fixture.calls.filter((call) => call.path === '/api/messages' && call.method === 'POST').length, 0);
        assert.deepEqual(errors, []);
      } finally {
        await writeFile(`${evidenceDir}/${name}-calls.json`, JSON.stringify({ errors, calls: fixture.calls }, null, 2));
        await page.screenshot({ path: `${evidenceDir}/${name}-final.png` }).catch(() => {});
        await context.close();
      }
    });
}
