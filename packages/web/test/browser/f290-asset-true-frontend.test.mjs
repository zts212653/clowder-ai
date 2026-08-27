import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const STORAGE_KEY = 'cat-cafe:f290-asset-collaboration:v1';
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
const BASE_URL = process.env.F290_BASE_URL ?? 'http://127.0.0.1:5173/dev/f290-asset-collaboration';
const EVIDENCE_DIR =
  process.env.F290_EVIDENCE_DIR ?? path.join(REPO_ROOT, 'assets/screenshots/F290-alpha-true-frontend');

const SENTINELS = {
  annotation: 'E2E-SENTINEL-批注-浏览器真实输入',
  discussion: 'E2E-SENTINEL-讨论-浏览器真实输入',
  edit: 'E2E-SENTINEL-正文-浏览器真实输入',
};

async function readState(page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) throw new Error(`Missing browser-owned state at ${key}`);
    return JSON.parse(raw);
  }, STORAGE_KEY);
}

test(
  'F290 browser journey grows DOM and browser-owned state, restores it, and follows history targets',
  { timeout: 60_000 },
  async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

    try {
      const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      assert.equal(response?.status(), 200, `F290 target must answer HTTP 200 at ${BASE_URL}`);
      await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
      await page.reload({ waitUntil: 'networkidle' });
      const collaborationNavigation = page.getByRole('navigation', { name: '协作内容' });

      const initialAnnotationCount = Number(await page.getByTestId('annotation-total').textContent());
      const initialHistoryCount = Number(await page.getByTestId('history-total').textContent());

      await page.locator('[data-annotate-section="memory"]').click();
      await page.getByLabel('给“记忆归属”添加批注').fill(SENTINELS.annotation);
      await page.getByRole('button', { name: '发送批注', exact: true }).click();

      assert.equal(Number(await page.getByTestId('annotation-total').textContent()), initialAnnotationCount + 1);
      assert.equal(Number(await page.getByTestId('history-total').textContent()), initialHistoryCount + 1);
      assert.equal(await page.getByText(SENTINELS.annotation, { exact: true }).count(), 1);
      const afterAnnotation = await readState(page);
      assert.equal(afterAnnotation.annotations.at(-1).body, SENTINELS.annotation);
      assert.equal(afterAnnotation.history.at(-1).action, 'annotated');
      const initialDiscussionCount = afterAnnotation.discussions.length;

      await collaborationNavigation.getByRole('button', { name: '讨论', exact: true }).click();
      await page.getByLabel('围绕整份产物讨论').fill(SENTINELS.discussion);
      await page.getByRole('button', { name: '发送讨论', exact: true }).click();

      assert.equal(await page.locator('[data-discussion-message]').count(), initialDiscussionCount + 1);
      assert.equal(Number(await page.getByTestId('annotation-total').textContent()), initialAnnotationCount + 1);
      assert.equal(await page.getByText(SENTINELS.discussion, { exact: true }).count(), 1);
      const afterDiscussion = await readState(page);
      assert.equal(afterDiscussion.discussions.at(-1).body, SENTINELS.discussion);
      assert.equal(afterDiscussion.history.at(-1).action, 'discussed');

      await page.getByRole('button', { name: '编辑产物', exact: true }).click();
      const memoryEditor = page.getByLabel('编辑“记忆归属”正文');
      await memoryEditor.fill(`${await memoryEditor.inputValue()} ${SENTINELS.edit}`);
      await page.getByRole('button', { name: '保存新版本', exact: true }).click();

      assert.match((await page.getByTestId('asset-version').textContent()) ?? '', /v4/);
      assert.match(
        (await page.locator('[data-section-body="memory"]').textContent()) ?? '',
        new RegExp(SENTINELS.edit),
      );
      const afterEdit = await readState(page);
      assert.equal(afterEdit.versions.length, 2);
      assert.equal(afterEdit.versions.at(-1).number, 4);
      assert.match(
        afterEdit.versions.at(-1).sections.find((section) => section.id === 'memory').body,
        new RegExp(SENTINELS.edit),
      );
      assert.equal(afterEdit.history.length, initialHistoryCount + 3);

      await page.screenshot({ path: path.join(EVIDENCE_DIR, 'mutated.png'), fullPage: true });
      await page.reload({ waitUntil: 'networkidle' });

      await collaborationNavigation.getByRole('button', { name: '批注', exact: true }).click();
      assert.equal(await page.getByText(SENTINELS.annotation, { exact: true }).count(), 1);
      assert.match(
        (await page.locator('[data-section-body="memory"]').textContent()) ?? '',
        new RegExp(SENTINELS.edit),
      );
      assert.match((await page.getByTestId('asset-version').textContent()) ?? '', /v4/);
      assert.equal(await page.getByRole('button', { name: '接受并更新', exact: true }).isDisabled(), true);
      assert.equal(await page.getByText(/正文已产生新版本/).count(), 1);
      assert.match(
        (await page.locator('[data-section-body="memory"]').textContent()) ?? '',
        new RegExp(SENTINELS.edit),
      );
      await collaborationNavigation.getByRole('button', { name: '讨论', exact: true }).click();
      assert.equal(await page.getByText(SENTINELS.discussion, { exact: true }).count(), 1);

      await collaborationNavigation.getByRole('button', { name: '历程', exact: true }).click();
      await page.locator('[data-history-action="annotated"]').first().click();
      assert.equal(await page.locator('[data-selected-section="memory"]').count(), 1);
      assert.match(
        (await page.locator('[data-active-annotation]').textContent()) ?? '',
        new RegExp(SENTINELS.annotation),
      );

      await collaborationNavigation.getByRole('button', { name: '历程', exact: true }).click();
      await page.locator('[data-history-action="edited"]').first().click();
      assert.match((await page.locator('[data-viewing-version]').textContent()) ?? '', new RegExp(SENTINELS.edit));
      await page.screenshot({ path: path.join(EVIDENCE_DIR, 'history-return.png'), fullPage: true });

      const restored = await readState(page);
      const evidence = {
        baseUrl: BASE_URL,
        storageKey: STORAGE_KEY,
        annotations: [initialAnnotationCount, restored.annotations.length],
        discussions: [initialDiscussionCount, restored.discussions.length],
        history: [initialHistoryCount, restored.history.length],
        versions: [3, restored.versions.at(-1).number],
        sentinels: SENTINELS,
        screenshots: ['mutated.png', 'history-return.png'],
      };
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

test('F290 rejects structurally invalid persisted state and restores the fixture', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200, `F290 target must answer HTTP 200 at ${BASE_URL}`);
    await page.evaluate((key) => {
      window.localStorage.removeItem(key);
    }, STORAGE_KEY);
    await page.reload({ waitUntil: 'networkidle' });
    const collaborationNavigation = page.getByRole('navigation', { name: '协作内容' });
    await collaborationNavigation.getByRole('button', { name: '讨论', exact: true }).click();
    await page.getByLabel('围绕整份产物讨论').fill('PERSISTENCE-VALIDATION-SEED');
    await page.getByRole('button', { name: '发送讨论', exact: true }).click();
    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error(`Missing browser-owned state at ${key}`);
      const state = JSON.parse(raw);
      state.asset.updatedAt = 7;
      window.localStorage.setItem(key, JSON.stringify(state));
    }, STORAGE_KEY);
    await page.reload({ waitUntil: 'networkidle' });

    assert.equal(await page.getByTestId('asset-stage').count(), 1);
    assert.match((await page.getByTestId('asset-version').textContent()) ?? '', /v3/);
    assert.match((await page.locator('[data-section-body="memory"]').textContent()) ?? '', /关系记忆/);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('F290 migrates prior v1 state without dropping user annotations', { timeout: 30_000 }, async () => {
  const sentinel = 'TERRA-REENTRY-LEGACY-V1-ANNOTATION';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200, `F290 target must answer HTTP 200 at ${BASE_URL}`);
    await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
    await page.reload({ waitUntil: 'networkidle' });
    const initialAnnotationCount = Number(await page.getByTestId('annotation-total').textContent());
    await page.locator('[data-annotate-section="memory"]').click();
    await page.getByLabel('给“记忆归属”添加批注').fill(sentinel);
    await page.getByRole('button', { name: '发送批注', exact: true }).click();
    assert.equal(Number(await page.getByTestId('annotation-total').textContent()), initialAnnotationCount + 1);

    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error(`Missing browser-owned state at ${key}`);
      const state = JSON.parse(raw);
      state.schemaVersion = 1;
      delete state.suggestions[0].baseVersionId;
      window.localStorage.setItem(key, JSON.stringify(state));
    }, STORAGE_KEY);
    await page.reload({ waitUntil: 'networkidle' });

    assert.equal(Number(await page.getByTestId('annotation-total').textContent()), initialAnnotationCount + 1);
    assert.equal(await page.getByText(sentinel, { exact: true }).count(), 1);
    await page.waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return false;
      const state = JSON.parse(raw);
      return state.schemaVersion === 2 && state.suggestions[0]?.baseVersionId === 'version-3';
    }, STORAGE_KEY);
  } finally {
    await page.close();
    await browser.close();
  }
});
