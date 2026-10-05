import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { realSurfaceApiResponse, THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

const baseUrl = process.env.F322_PREVIEW_URL ?? 'http://localhost:5112';
const evidenceDir = process.env.F322_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f322-status');
const now = Date.now();

const cats = [
  {
    id: 'codex-sol',
    displayName: '缅因猫 Sol（GPT-5.6 Sol）',
    color: { primary: '#5B8C5A' },
    clientId: 'openai',
    defaultModel: 'gpt-5.6-sol',
  },
  {
    id: 'codex6-sol',
    displayName: '缅因猫 Sol（GPT-6 Sol）',
    color: { primary: '#5B8C5A' },
    clientId: 'openai',
    defaultModel: 'gpt-6-sol',
  },
  {
    id: 'kimi',
    displayName: '梵花猫（kimi k3）',
    color: { primary: '#4B5563' },
    clientId: 'kimi',
    defaultModel: 'kimi-code/k3',
  },
];

const sessions = [
  {
    id: 'older-sol',
    cliSessionId: 'cli-older-sol',
    catId: 'codex-sol',
    seq: 0,
    status: 'active',
    messageCount: 4,
    createdAt: now - 45 * 3600_000,
    compressionCount: 0,
  },
  {
    id: 'working-sol',
    cliSessionId: 'cli-working-sol-complete-value-that-overflows-a-300px-workspace',
    catId: 'codex6-sol',
    seq: 0,
    status: 'active',
    messageCount: 9,
    createdAt: now - 40 * 3600_000,
    compressionCount: 0,
    lastUsage: { inputTokens: 102000, outputTokens: 3000, cacheReadTokens: 94000 },
  },
  {
    id: 'kimi-session',
    cliSessionId: 'cli-kimi',
    catId: 'kimi',
    seq: 2,
    status: 'active',
    messageCount: 7,
    createdAt: now - 39 * 3600_000,
    compressionCount: null,
  },
  {
    id: 'sealed-one',
    cliSessionId: 'cli-sealed-one',
    catId: 'codex-sol',
    seq: 1,
    status: 'sealed',
    messageCount: 8,
    createdAt: now - 70 * 3600_000,
    sealedAt: now - 46 * 3600_000,
    sealReason: 'manual',
  },
  {
    id: 'sealed-two',
    cliSessionId: 'cli-sealed-two',
    catId: 'kimi',
    seq: 1,
    status: 'sealed',
    messageCount: 3,
    createdAt: now - 60 * 3600_000,
    sealedAt: now - 40 * 3600_000,
    sealReason: 'threshold',
  },
];

const liveInvocations = [
  {
    catId: 'codex6-sol',
    startedAt: now - 10000,
    executionId: 'working-sol-run',
    turnInvocationId: 'working-sol-invocation',
  },
];

function fixtureResponse(request, { activeInvocations = liveInvocations, sessionRows = sessions } = {}) {
  const url = new URL(request.url());
  if (url.pathname === '/api/cats') return { body: { cats } };
  if (url.pathname === '/api/config/cat-order') return { body: { catOrder: cats.map((cat) => cat.id) } };
  if (url.pathname === `/api/threads/${THREAD_ID}/sessions`) return { body: { sessions: sessionRows } };
  if (url.pathname === `/api/threads/${THREAD_ID}/queue`) {
    return {
      body: {
        queue: [],
        paused: false,
        activeInvocations,
      },
    };
  }
  if (url.pathname === '/api/executions/active') {
    return {
      body: {
        projectPath: '/project/cat-cafe',
        executions: [],
      },
    };
  }
  return realSurfaceApiResponse(request, false);
}

async function openStatus(page, fixture = {}) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', (route) => {
    const response = fixtureResponse(route.request(), fixture);
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  await page.goto(new URL(`/thread/${THREAD_ID}`, baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await page
    .getByTestId('workspace-panel-toggle')
    .waitFor({ timeout: 10_000 })
    .catch(async () => {
      throw new Error(
        `Workspace entry missing: ${JSON.stringify({ pageErrors, body: (await page.locator('body').innerText()).slice(0, 2500) })}`,
      );
    });
  await ensureWorkspaceOpen(page);
  await page.getByTestId('workspace-launcher-status').click();
  await page.getByText('查看会话、对话标识与运行详情').waitFor();
  const panel = page.locator('[data-console-panel="status"]');
  await panel.waitFor();
  await panel.getByTestId('session-card-active').first().waitFor();
  assert.equal(await panel.getByTestId('session-card-active').count(), 3);
  return panel;
}

async function resizeWorkspace(page, panel, targetWidth) {
  const handle = page.getByRole('separator', { name: '右侧面板分隔条', exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await panel.boundingBox();
    assert.ok(box);
    if (Math.abs(box.width - targetWidth) <= 8) return box;
    const grip = await handle.boundingBox();
    assert.ok(grip);
    const x = grip.x + grip.width / 2;
    const y = grip.y + Math.min(grip.height / 2, 200);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width - targetWidth, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  const box = await panel.boundingBox();
  assert.ok(
    box && Math.abs(box.width - targetWidth) <= 8,
    `actual Status width ${box?.width}, expected ${targetWidth}`,
  );
  return box;
}

test(
  'pre-F322 Status shows statistics, IDs, usage and actions in the original default layout',
  { timeout: 120_000 },
  async () => {
    await mkdir(evidenceDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { width: 1440, height: 900, name: 'desktop' },
        { width: 390, height: 844, name: 'narrow' },
      ]) {
        const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        try {
          const panel = await openStatus(page);
          await panel.getByRole('heading', { name: '会话记录', exact: true }).waitFor();
          await panel.getByRole('heading', { name: '消息统计', exact: true }).waitFor();
          await panel.getByRole('heading', { name: '对话信息', exact: true }).waitFor();
          assert.equal(await panel.getByTestId('session-chain-summary').count(), 0);
          assert.equal(await panel.getByRole('button', { name: '查看详情与操作' }).count(), 0);
          assert.equal(await panel.getByRole('button', { name: '查看技术详情' }).count(), 0);
          const row = panel
            .getByTestId('session-card-active')
            .filter({ has: page.locator('[data-cat-id="codex6-sol"]') });
          await row.getByText('第 1 段会话', { exact: true }).waitFor();
          await row.getByRole('button', { name: '封存当前会话', exact: true }).waitFor();
          assert.equal(await row.getByRole('button', { name: '原生压缩', exact: true }).isDisabled(), true);
          assert.match(await row.innerText(), /102k/);
          const id = row.getByRole('button', {
            name: '复制会话 ID：cli-working-sol-complete-value-that-overflows-a-300px-workspace',
            exact: true,
          });
          await id.focus();
          await page.keyboard.press('Enter');
          await id.getByRole('status').getByText('已复制').waitFor();
          assert.equal(
            await page.evaluate(() => navigator.clipboard.readText()),
            'cli-working-sol-complete-value-that-overflows-a-300px-workspace',
          );
          const threadId = panel.getByRole('button', { name: `复制对话 ID：${THREAD_ID}`, exact: true });
          await threadId.click();
          await threadId.getByRole('status').getByText('已复制').waitFor();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), THREAD_ID);
          await page.screenshot({ path: path.join(evidenceDir, `${viewport.name}-restored.png`), fullPage: true });
          await panel.screenshot({ path: path.join(evidenceDir, `${viewport.name}-restored-panel.png`) });
          if (viewport.width === 1440) {
            for (const width of [420, 300]) {
              await resizeWorkspace(page, panel, width);
              const card = panel
                .getByTestId('session-card-active')
                .filter({ has: page.locator('[data-cat-id="codex6-sol"]') });
              await card.getByRole('button', { name: '封存当前会话', exact: true }).waitFor();
              assert.equal(await card.getByRole('button', { name: '原生压缩', exact: true }).isDisabled(), true);
              const fullId = card.getByRole('button', {
                name: '复制会话 ID：cli-working-sol-complete-value-that-overflows-a-300px-workspace',
                exact: true,
              });
              await fullId.click();
              await fullId.getByRole('status').getByText('已复制').waitFor();
              assert.equal(
                await page.evaluate(() => navigator.clipboard.readText()),
                'cli-working-sol-complete-value-that-overflows-a-300px-workspace',
              );
              await page.screenshot({
                path: path.join(evidenceDir, `workspace-${width}-restored.png`),
                fullPage: true,
              });
              await panel.screenshot({ path: path.join(evidenceDir, `workspace-${width}-restored-panel.png`) });
            }
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
);

test('restored idle records keep compact, seal and historical restore reachable', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const panel = await openStatus(page, { activeInvocations: [] });
    const row = panel.getByTestId('session-card-active').first();
    assert.equal(await row.getByRole('button', { name: '封存当前会话', exact: true }).isDisabled(), false);
    assert.equal(await row.getByRole('button', { name: '原生压缩', exact: true }).isDisabled(), false);
    await panel.getByTestId('sealed-toggle').click();
    await panel.getByTestId('session-card-sealed').first().waitFor();
    await panel.getByTestId('restore-session-sealed-one').waitFor();
    assert.equal(await panel.getByTestId('restore-session-sealed-one').isDisabled(), false);
    await page.screenshot({ path: path.join(evidenceDir, 'narrow-idle-restored.png'), fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }
});

test('original layout keeps ambiguous cat-scoped actions guarded', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const duplicateRows = sessions.map((row) =>
      ['older-sol', 'sealed-one'].includes(row.id) ? { ...row, catId: 'codex6-sol' } : row,
    );
    const panel = await openStatus(page, { sessionRows: duplicateRows });
    const rows = panel.getByTestId('session-card-active').filter({ has: page.locator('[data-cat-id="codex6-sol"]') });
    assert.equal(await rows.count(), 2);
    for (let index = 0; index < 2; index++) {
      const row = rows.nth(index);
      assert.equal(await row.getAttribute('data-session-lifecycle'), 'unverified');
      assert.equal(await row.getByRole('button', { name: '原生压缩', exact: true }).isDisabled(), true);
      assert.equal(await row.getByRole('button', { name: '绑定会话 ID…', exact: true }).isDisabled(), true);
    }
    await panel.getByTestId('sealed-toggle').click();
    assert.equal(await panel.getByTestId('restore-session-sealed-one').isDisabled(), true);
    await page.screenshot({ path: path.join(evidenceDir, 'narrow-ambiguous-restored.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await resizeWorkspace(page, panel, 300);
    const sealedSummary = panel
      .getByTestId('session-card-sealed')
      .filter({ has: page.getByTestId('restore-session-sealed-one') })
      .getByTestId('sealed-session-summary');
    const summaryBox = await sealedSummary.boundingBox();
    assert.ok(
      summaryBox && summaryBox.width >= 96 && summaryBox.height <= 100,
      `sealed metadata must remain readable in a 300px Workspace: ${JSON.stringify(summaryBox)}`,
    );
    const sealedId = panel.getByRole('button', { name: '复制会话 ID：cli-sealed-one', exact: true });
    const sealedIdBox = await sealedId.boundingBox();
    assert.ok(
      sealedIdBox && sealedIdBox.width >= 48,
      'sealed ID must remain a visible click target in a 300px Workspace',
    );
    await page.screenshot({ path: path.join(evidenceDir, 'workspace-300-ambiguous-restored.png'), fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }
});
