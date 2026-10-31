import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createSubmittedChoiceProjection } from './f311-preparation-choice.journey.mjs';
import {
  createPmPreparationProgramFixture,
  verifyPreparationWorkspace,
} from './f311-preparation-workspace.journey.mjs';
import { waitForResponsiveWorkspaceLayout } from './f311-responsive-workspace-layout.mjs';
import { CONTRACT_THREAD_ID, startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';

await import('tsx');
const { default: programFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-fixtures.ts'
);
const { default: preparationFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-preparation-fixtures.ts'
);
const { PROGRAM_ID, programFixture } = programFixtures;
const { evolutionPreparationFixture } = preparationFixtures;
const evidenceDir = process.env.F311_EVIDENCE_DIR;
const report = { mode: 'isolated-contract', measurements: {}, claims: [] };
let fixture;
let browser;

before(
  async () => {
    fixture = await startEvolutionWorkspaceBrowserFixture(
      createPmPreparationProgramFixture(programFixture, evolutionPreparationFixture, CONTRACT_THREAD_ID),
    );
    browser = await chromium.launch({ headless: true });
    if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  },
  { timeout: 210_000 },
);

after(async () => {
  await browser?.close();
  await fixture?.close();
  assert.deepEqual(fixture?.programWrites, [], 'fixture owner must receive no Program writes');
  if (evidenceDir) {
    await writeFile(`${evidenceDir}/preparation-measurements.json`, `${JSON.stringify(report, null, 2)}\n`);
  }
});

async function authenticatedPage() {
  const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
  const base = new URL(fixture.webUrl);
  const api = new URL(fixture.apiUrl);
  await context.route('**/api/**', (route) => {
    const origin = new URL(route.request().url()).origin;
    assert([base.origin, api.origin].includes(origin), `contract request escaped its owned servers: ${origin}`);
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(new URL('/api/session', api).href);
  assert.equal(JSON.parse(await page.locator('body').innerText()).userId, 'default-user');
  return { page, context };
}

async function navigateShell(page, url) {
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/cats'),
    page.goto(url, { waitUntil: 'load' }),
  ]);
}

function targetUrl() {
  const url = new URL(`/thread/${CONTRACT_THREAD_ID}`, fixture.webUrl);
  url.searchParams.set('evolutionProgram', PROGRAM_ID);
  url.searchParams.set('evolutionView', 'judgment');
  return url.href;
}

async function assertContained(locator) {
  const sizes = await locator.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  assert(sizes.scroll <= sizes.client + 1, `horizontal overflow: ${JSON.stringify(sizes)}`);
}

async function capture(page, name) {
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/${name}.png` });
}

test(
  'production preparation submissions remain honest and readable in the real F307 shell',
  { timeout: 120_000 },
  async () => {
    const { page, context } = await authenticatedPage();
    try {
      report.measurements.preparationWorkspace = await verifyPreparationWorkspace({
        page,
        threadId: CONTRACT_THREAD_ID,
        targetUrl,
        navigateShell,
        capture,
        assertContained,
        programFixture,
        evolutionPreparationFixture,
      });
      report.claims.push(report.measurements.preparationWorkspace.claim);
    } catch (error) {
      await capture(page, 'preparation-workspace-failure');
      throw error;
    } finally {
      await context.close();
    }
  },
);

test(
  'reads a new human input and cat recommendation submitted through the real preparation service',
  { timeout: 90_000 },
  async () => {
    const { projection, inputId, revision } = await createSubmittedChoiceProjection(evolutionPreparationFixture);
    const { page, context } = await authenticatedPage();
    try {
      await page.route('**/api/capability-evolution/programs**', (route) => {
        const url = new URL(route.request().url());
        assert.equal(route.request().method(), 'GET');
        if (/\/(asset-review|preparation-review|exploration)$/.test(url.pathname))
          return route.fulfill({ status: 404, json: { error: 'owner_not_connected' } });
        return route.fulfill({ json: url.pathname.endsWith('/programs') ? { programs: [projection] } : projection });
      });
      const url = new URL(targetUrl());
      url.searchParams.set('evolutionProgram', projection.program.programId);
      await navigateShell(page, url.href);
      const surface = page.getByTestId('evolution-program-surface');
      await surface
        .getByRole('navigation', { name: '能力进化旅程' })
        .getByRole('button', { name: '准备', exact: true })
        .click();
      const item = surface.locator('[data-preparation-item="data"]');
      await item.getByText('Europa 晨会材料路由', { exact: true }).waitFor();
      await item.getByText('Harness / 信息转交', { exact: true }).waitFor();
      await item.locator('summary').first().click();
      await item.getByText('先核失败分母', { exact: true }).first().waitFor();
      await item.getByRole('button', { name: '回读人的原输入', exact: true }).waitFor();
      assert.match(await item.innerText(), /保持固定/u);
      assert.equal(await item.locator('input,select,textarea').count(), 0);
      assert.equal(await item.locator('[data-preparation-spinner]').count(), 0);
      await capture(page, 'preparation-submitted-stranger-desktop');
      await navigateShell(page, url.href);
      await surface
        .locator('[data-preparation-item="data"]')
        .getByText('Europa 晨会材料路由', { exact: true })
        .waitFor();
      for (const width of [416, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await waitForResponsiveWorkspaceLayout(page, surface, width);
        await assertContained(surface);
        await surface.locator('[data-preparation-item="data"]').scrollIntoViewIfNeeded();
        await capture(page, `preparation-submitted-stranger-${width}`);
      }
      report.measurements.submittedChoice = {
        inputId,
        revision,
        author: 'codex-astra',
        restored: true,
        claim:
          'Canonical preparation service and F117 carrier with new synthetic human input; real product shell, not production content.',
      };
    } finally {
      await context.close();
    }
  },
);
