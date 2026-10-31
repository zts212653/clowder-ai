import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startFinalAccountPreview } from './f320-final-runtime.fixture.mjs';

// Real Next /settings route and original account/config API on disposable files.
// Routing facts are controlled owner reads; no real provider, runtime or Redis writes.
const evidence = process.env.F322_SETTINGS_EVIDENCE_DIR ?? join(tmpdir(), 'cat-cafe-evidence', 'f322-settings-help');
let preview, browser;
const recordedAt = Date.UTC(2026, 9, 13, 10, 0);
function routingSnapshot() {
  const common = { v: 1, ownerId: 'fixture', observedAt: Date.now(), catalogRevision: 'settings-controlled' };
  return {
    ...common,
    signalEvents: [
      {
        v: 1,
        ownerId: 'fixture',
        eventId: 'settings-recovery',
        commandId: 'settings-success',
        subjectRef: { type: 'cat', catId: 'codex61-sol' },
        source: 'dispatch_success',
        reasonCode: 'dispatch_success_probe',
        observedAt: recordedAt,
        probeStartedAt: recordedAt - 1000,
        evidenceRef: 'controlled:settings-dispatch-success',
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: [],
      },
    ],
    preferenceRevisions: [
      {
        v: 1,
        ownerId: 'fixture',
        preferenceId: 'settings-rule',
        revisionId: 'settings-rule-1',
        commandId: 'settings-preference',
        version: 1,
        validFrom: recordedAt - 2000,
        lifecycle: 'active',
        appliesWhen: { intent: 'review' },
        prefer: [{ type: 'cat', catId: 'codex61-sol' }],
        over: [{ type: 'cat', catId: 'codex-sol' }],
        rationale: 'Controlled owner reason; not the rule summary.',
        evidenceRefs: ['controlled:settings-rule'],
      },
    ],
    resolution: {
      state: 'fresh',
      inputRevisionRef: 'settings-controlled-read',
      sourceRefs: {
        signalEventIds: ['settings-recovery'],
        preferenceRevisionIds: ['settings-rule-1'],
        dossierRevisions: [],
      },
      snapshot: {
        ...common,
        candidates: [
          {
            binding: { v: 1, catId: 'codex61-sol', providerId: 'openai', provenQuotaPools: [] },
            profile: { state: 'absent' },
            availability: 'available',
            freshness: 'fresh',
            effect: 'eligible',
            matchedPreferences: [{ revisionId: 'settings-rule-1', lifecycle: 'active' }],
            reasons: [
              {
                code: 'routing_signal_recovered',
                summary: 'dispatch_success_probe',
                sourceRefs: ['settings-recovery'],
              },
            ],
          },
        ],
      },
    },
  };
}
before(async () => {
  preview = await startFinalAccountPreview({ routingSnapshot, withServicePreview: true, ownerUserId: 'fixture' });
  browser = await chromium.launch({ headless: true });
  if (evidence) await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  await preview?.close();
});
test('settings initializes a pending preview after a language switch', { timeout: 180000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('cat-cafe:shell-language', 'en');
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  });
  const page = await context.newPage();
  const errors = [],
    writes = [],
    reads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/services/'))
      writes.push({ url: request.url(), method: request.method() });
  });
  let releaseFirst, firstCaptured;
  const firstReady = new Promise((resolve) => {
    firstCaptured = resolve;
  });
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  await page.route('**/api/services/whisper-stt/install-preview?locale=*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const locale = new URL(route.request().url()).searchParams.get('locale');
    reads.push({ locale, status: response.status(), body });
    if (locale === 'en') {
      firstCaptured();
      await firstRelease;
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${preview.url}/settings?s=voice&shell=v2`, { waitUntil: 'domcontentloaded' });
    const whisper = page.getByTestId('service-status-detail-whisper-stt').locator('../..');
    await whisper.getByRole('button', { name: '修改端口或模型' }).click();
    await firstReady;
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Checking environment…', { exact: true }).waitFor();
    await page.evaluate(() => {
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      window.dispatchEvent(new CustomEvent('cat-cafe:shell-language-sync'));
    });
    await dialog.getByRole('heading', { name: '修改 语音识别 (Whisper)', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const modal = document.querySelector('[role="dialog"]');
      return (
        modal?.querySelector('input[type="radio"]:checked') &&
        !modal.querySelector('button.console-button-primary')?.disabled
      );
    });
    const before = await dialog
      .locator('input')
      .evaluateAll((inputs) =>
        inputs.map((input) => ({ type: input.type, value: input.value, checked: input.checked })),
      );
    assert.ok(before.some((input) => input.value === '19876'));
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/services/whisper-stt/install-preview' &&
        new URL(response.url()).searchParams.get('locale') === 'en',
    );
    releaseFirst();
    await oldResponse;
    // A following real owner read proves the browser has consumed the old response before the final assertions.
    const owner = await page.request.get(`${preview.apiUrl}/api/services`, {
      headers: { 'x-cat-cafe-user': 'fixture' },
    });
    assert.equal(owner.status(), 200);
    const zhRead = reads.find((read) => read.locale === 'zh');
    assert.equal(zhRead?.status, 200);
    await dialog.getByText(zhRead.body.recommendation.models[0].description, { exact: true }).waitFor();
    assert.equal(await dialog.locator('button.console-button-primary').isEnabled(), true);
    assert.deepEqual(
      await dialog
        .locator('input')
        .evaluateAll((inputs) =>
          inputs.map((input) => ({ type: input.type, value: input.value, checked: input.checked })),
        ),
      before,
    );
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(evidence, 'initial-language-race-390.png'), fullPage: true });
    await writeFile(
      join(evidence, 'initial-language-race.json'),
      JSON.stringify(
        {
          reads,
          before,
          errors,
          writes,
          realNextPage: true,
          preview: {
            webUrl: preview.url,
            apiUrl: preview.apiUrl,
            webWorkingDirectory: fileURLToPath(new URL('../../', import.meta.url)),
            apiWorkingDirectory: process.cwd(),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    releaseFirst();
    await context.close();
  }
});
for (const [language, width, dark] of [
  ['zh', 1440, false],
  ['zh', 390, true],
  ['en', 1440, false],
  ['en', 390, true],
])
  test(`settings explanations keep original actions in ${language}/${width}`, { timeout: 180000 }, async () => {
    const narrow = width === 390;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: narrow });
    await context.addInitScript(
      ({ language, dark }) => {
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        if (dark) {
          localStorage.setItem('theme', 'dark');
          localStorage.setItem(
            'cat-cafe:themes',
            JSON.stringify({ activeId: 'dark', custom: [], builtInOverrides: {} }),
          );
        }
      },
      { language, dark },
    );
    const page = await context.newPage();
    const errors = [],
      writes = [];
    let savedOrder;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/api/'))
        writes.push({ path: new URL(r.url()).pathname, method: r.method(), body: r.postData() });
    });
    try {
      await page.goto(`${preview.url}/settings?s=members&shell=v2`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('member-list-page').waitFor();
      const routingRead = await page.request.get(`${preview.apiUrl}/api/routing-context/snapshot`, {
        headers: { 'x-cat-cafe-user': 'fixture' },
      });
      const routingBody = await routingRead.json();
      if (evidence)
        await writeFile(
          join(evidence, `routing-${language}-${width}.json`),
          JSON.stringify({ status: routingRead.status(), body: routingBody }, null, 2),
        );
      assert.equal(routingRead.status(), 200, JSON.stringify(routingBody));

      const status = page.locator('tr[data-cat-id="codex61-sol"] .member-status');
      await status.getByText(language === 'zh' ? '已恢复' : 'Recovered', { exact: true }).waitFor();
      await status
        .getByText(language === 'zh' ? '最近一次接活顺利完成' : 'The latest work dispatch finished successfully', {
          exact: true,
        })
        .waitFor();
      assert.equal(await status.locator('time').getAttribute('datetime'), new Date(recordedAt).toISOString());
      await status.scrollIntoViewIfNeeded();
      await status
        .getByRole('button', { name: language === 'zh' ? '关于恢复依据' : 'About Recovery evidence' })
        .click();
      const recovery = page.getByRole('dialog', {
        name: language === 'zh' ? '关于恢复依据' : 'About Recovery evidence',
      });
      await recovery
        .getByText(
          language === 'zh'
            ? '证据：controlled:settings-dispatch-success'
            : 'Evidence: controlled:settings-dispatch-success',
          { exact: true },
        )
        .waitFor();
      await page.screenshot({ path: join(evidence, `recovery-evidence-${language}-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      const rules = page.getByLabel(language === 'zh' ? '当前规则' : 'Current rules', { exact: true });
      assert.match(await rules.innerText(), language === 'zh' ? /审查：/u : /Review:/u);
      assert.equal(await rules.locator('details').getAttribute('open'), null);
      const help = page.getByRole('button', {
        name: language === 'zh' ? '关于默认猫' : 'About Default cat',
        exact: true,
      });
      await help.focus();
      const dialog = page.getByRole('dialog', {
        name: language === 'zh' ? '关于默认猫' : 'About Default cat',
        exact: true,
      });
      await dialog.waitFor();
      await help.click(); // focus is transient; click pins it.
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      if (narrow) await help.tap();
      else {
        await page.mouse.move(0, 0);
        await help.hover();
      }
      await dialog.waitFor();
      assert.equal(
        await dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        }),
        true,
      );
      if (evidence)
        await page.screenshot({ path: join(evidence, `members-help-${language}-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      // The real original ordering control remains actionable; test the existing writer on disposable configuration.
      if (!narrow && language === 'zh') {
        const sort = page.locator('tr[data-cat-id="codex61-sol"] .member-sort');
        const described = await sort.getAttribute('aria-describedby');
        assert.ok(described && (await page.locator(`[id="${described}"]`).textContent()));
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/config/cat-order' && response.request().method() === 'PUT',
        );
        await sort.press('ArrowDown');
        const response = await saved;
        const body = await response.json();
        assert.equal(response.status(), 200, JSON.stringify(body));
        await page.waitForFunction(
          () => document.querySelector('tr[data-cat-id]')?.getAttribute('data-cat-id') === 'codex-sol',
        );
        assert.equal(writes.filter((w) => w.path === '/api/config/cat-order' && w.method === 'PUT').length, 1);
        const preferences = JSON.parse(
          await readFile(join(preview.root, '.cat-cafe', 'user-preferences.json'), 'utf8'),
        );
        assert.deepEqual(preferences.catOrder, ['codex-sol', 'codex61-sol']);
        savedOrder = { response: body, persisted: preferences.catOrder };
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => document.querySelector('tr[data-cat-id]')?.getAttribute('data-cat-id') === 'codex-sol',
        );
      }
      await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
      const search = page.getByRole('searchbox', {
        name: language === 'zh' ? '搜索账户或成员' : 'Search accounts or members',
      });
      await search.waitFor();
      assert.equal(
        await search.getAttribute('placeholder'),
        language === 'zh' ? '搜索账户或成员' : 'Search accounts or members',
      );
      await page.getByRole('button', { name: language === 'zh' ? '+ 添加账号' : '+ Add account', exact: true }).click();
      await page
        .getByText(
          language === 'zh'
            ? '本机默认登录不用添加。新增的号登录后不会自动换上。'
            : 'Local default logins do not need adding. A new login is not selected automatically.',
          { exact: true },
        )
        .waitFor();
      assert.equal(writes.filter((w) => w.path.startsWith('/api/accounts') && w.method !== 'GET').length, 0);
      if (evidence)
        await page.screenshot({ path: join(evidence, `accounts-add-notice-${language}-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.keyboard.press('Escape');
      await page.goto(`${preview.url}/settings?s=voice&shell=v2`, { waitUntil: 'domcontentloaded' });
      const servicesRead = await page.request.get(`${preview.apiUrl}/api/services`, {
        headers: { 'x-cat-cafe-user': 'fixture' },
      });
      const servicesBody = await servicesRead.json();
      await writeFile(
        join(evidence, `services-${language}-${width}.json`),
        JSON.stringify({ status: servicesRead.status(), body: servicesBody }, null, 2),
      );
      assert.equal(servicesRead.status(), 200, JSON.stringify(servicesBody));
      await page.screenshot({ path: join(evidence, `voice-entry-${language}-${width}.png`), fullPage: true });
      const whisper = page.getByTestId('service-status-detail-whisper-stt').locator('../..');
      const ownerRead = page
        .waitForResponse((response) => new URL(response.url()).pathname === '/api/services/whisper-stt/install-preview')
        .catch((error) => ({ error }));
      await whisper.getByRole('button', { name: '修改端口或模型' }).click();
      await page.getByRole('dialog').waitFor();
      const ownerResponse = await ownerRead;
      assert.ok(!('error' in ownerResponse), 'No owner preview response');
      assert.equal(ownerResponse.status(), 200);
      assert.equal(new URL(ownerResponse.url()).searchParams.get('locale'), language);
      const ownerPreview = await ownerResponse.json();
      const install = page.getByRole('dialog');
      await install
        .getByRole('heading', {
          name: language === 'zh' ? '修改 语音识别 (Whisper)' : 'Reconfigure Speech recognition (Whisper)',
          exact: true,
        })
        .waitFor();
      const description =
        ownerPreview.recommendation.models[0]?.description ?? ownerPreview.recommendation.unsupported?.reason;
      assert.ok(description);
      await install.getByText(description, { exact: true }).waitFor();
      if (language === 'en')
        assert.doesNotMatch(
          JSON.stringify({
            models: ownerPreview.recommendation.models.map(({ description, performance }) => ({
              description,
              performance,
            })),
            notes: ownerPreview.recommendation.notes,
            unsupported: ownerPreview.recommendation.unsupported,
          }),
          /[\p{Script=Han}]/u,
        );
      if (evidence)
        await page.screenshot({ path: join(evidence, `install-preview-${language}-${width}.png`), fullPage: true });
      await install.getByRole('button', { name: language === 'zh' ? '关闭' : 'Close', exact: true }).click();
      assert.equal(writes.filter((w) => w.path.startsWith('/api/services/')).length, 0);
      assert.deepEqual(errors, []);
      if (evidence)
        await writeFile(
          join(evidence, `report-${language}-${width}.json`),
          JSON.stringify(
            {
              language,
              width,
              dark,
              recordedAt,
              writes,
              savedOrder,
              errors,
              controlledRoutingRead: true,
              realNextPage: true,
              preview: {
                webUrl: preview.url,
                apiUrl: preview.apiUrl,
                webWorkingDirectory: fileURLToPath(new URL('../../', import.meta.url)),
                apiWorkingDirectory: process.cwd(),
              },
            },
            null,
            2,
          ),
        );
    } catch (error) {
      console.error(error);
      if (evidence) {
        await page.screenshot({ path: join(evidence, `failure-${language}-${width}.png`), fullPage: true });
        await writeFile(join(evidence, `failure-${language}-${width}.html`), await page.content());
      }
      throw error;
    } finally {
      await context.close();
    }
  });
