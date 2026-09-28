import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { CONTRACT_THREAD_ID, startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';
import {
  createMicroduckProgramFixture,
  MICRODUCK_BASELINE_VERSION,
  verifyMicroduckPreparationReading,
} from './f311-workspace-owner-reading.journey.mjs';
import { verifyJourneyProgress } from './f311-workspace-progress.journey.mjs';
import { verifyUnnamedWorkspaceReadability } from './f311-workspace-readability.journey.mjs';
import { verifyWorkspaceSidecarReturn } from './f311-workspace-sidecar.journey.mjs';
import { verifyRichVersionReview } from './f311-workspace-version-review.journey.mjs';

await import('tsx');
const { default: assetFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-asset-fixtures.ts'
);
const { default: programFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-fixtures.ts'
);
const { default: preparationFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-preparation-fixtures.ts'
);
const { assetReviewFixture } = assetFixtures;
const { assetRef, PROGRAM_ID, programFixture } = programFixtures;
const { evolutionPreparationFixture } = preparationFixtures;

function microduckProgramWithEmptyPreparation() {
  const projection = createMicroduckProgramFixture(programFixture);
  const preparation = evolutionPreparationFixture();
  for (const section of Object.values(preparation.sections)) {
    section.current = null;
    section.history = [];
    section.activities = [];
  }
  projection.preparation = preparation;
  return projection;
}

const liveAlpha = Boolean(process.env.F311_WEB_URL);
const threadId = liveAlpha ? (process.env.F311_THREAD_ID ?? 'thread_mtksn1t642wmlu78') : CONTRACT_THREAD_ID;
const evidenceDir = process.env.F311_EVIDENCE_DIR;
const report = {
  mode: liveAlpha ? 'live-alpha' : 'isolated-contract',
  viewport: { width: 1440, height: 960 },
  measurements: {},
  claims: [],
};
let base, api, fixture, browser;
before(
  async () => {
    if (liveAlpha) {
      base = new URL(process.env.F311_WEB_URL);
      api = new URL(process.env.F311_ALPHA_API_URL ?? 'http://localhost:3012');
    } else {
      fixture = await startEvolutionWorkspaceBrowserFixture(microduckProgramWithEmptyPreparation());
      base = new URL(fixture.webUrl);
      api = new URL(fixture.apiUrl);
    }
    for (const url of [base, api])
      assert(['localhost', '127.0.0.1'].includes(url.hostname) && !['3001', '3002'].includes(url.port));
    browser = await chromium.launch({ headless: true });
    if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  },
  { timeout: 210_000 },
);
after(async () => {
  await browser?.close();
  await fixture?.close();
  if (fixture) assert.deepEqual(fixture.programWrites, [], 'reading must not send Program mutations');
  if (evidenceDir) await writeFile(`${evidenceDir}/measurements.json`, `${JSON.stringify(report, null, 2)}\n`);
});

async function capture(page, name) {
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/${name}.png` });
}
function targetUrl(view = 'judgment', version) {
  const url = new URL(`/thread/${threadId}`, base);
  url.searchParams.set('evolutionProgram', PROGRAM_ID);
  url.searchParams.set('evolutionView', view);
  if (version) url.searchParams.set('evolutionVersion', JSON.stringify(assetRef(version)));
  return url.href;
}
async function authenticatedPage() {
  const context = await browser.newContext({ viewport: report.viewport });
  if (!liveAlpha)
    await context.route('**/api/**', (route) => {
      const origin = new URL(route.request().url()).origin;
      assert([base.origin, api.origin].includes(origin), `contract request escaped its owned servers: ${origin}`);
      return route.continue();
    });
  const page = await context.newPage();
  // Live mode uses the canonical direct-loopback Alpha session; gate mode uses the synthetic API.
  await page.goto(new URL('/api/session', api).href);
  assert.equal(JSON.parse(await page.locator('body').innerText()).userId, 'default-user');
  assert.equal((await page.request.get(new URL(`/api/threads/${threadId}`, api).href)).status(), 200);
  return { page, context };
}
async function navigateShell(page, url) {
  // Server-rendered controls precede client hydration in a cold dev server.
  // A shell effect's real API response establishes that handlers are mounted.
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/cats'),
    page.goto(url, { waitUntil: 'load' }),
  ]);
}
async function assertContained(locator) {
  const sizes = await locator.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  assert(sizes.scroll <= sizes.client + 1, `horizontal overflow: ${JSON.stringify(sizes)}`);
}
test('journey navigation and an explicit progress request work in the real shell', { timeout: 90_000 }, async () => {
  const { page, context } = await authenticatedPage();
  try {
    report.measurements.journeyProgress = await verifyJourneyProgress({
      page,
      projection: programFixture(),
      threadId,
      targetUrl,
      navigateShell,
      capture,
      assertContained,
    });
  } catch (error) {
    await capture(page, 'journey-failure');
    throw error;
  } finally {
    await context.close();
  }
});

test('unnamed project context and next steps remain readable in the real shell', { timeout: 90_000 }, async () => {
  const { page, context } = await authenticatedPage();
  try {
    report.measurements.unnamedReadability = await verifyUnnamedWorkspaceReadability({
      page,
      base,
      threadId,
      programFixture,
      navigateShell,
      capture,
      assertContained,
    });
    report.claims.push(
      'Unnamed contract fixtures preserve readable source conversations and stage-specific pending work at 1440/390/320; not owner truth or Alpha outcome.',
    );
  } catch (error) {
    await capture(page, 'readability-failure');
    throw error;
  } finally {
    await context.close();
  }
});

test(
  `${liveAlpha ? 'real Alpha' : 'isolated contract'} Program traverses the actual rail, main review, history and close return`,
  { timeout: 90_000 },
  async () => {
    const { page, context } = await authenticatedPage();
    try {
      const response = await page.request.get(
        new URL(`/api/capability-evolution/programs/${encodeURIComponent(PROGRAM_ID)}`, base).href,
      );
      assert.equal(response.status(), 200);
      const projection = await response.json();
      assert.equal(projection.program.programId, PROGRAM_ID);
      await navigateShell(page, new URL(`/thread/${threadId}`, base).href);
      await ensureWorkspaceOpen(page);
      await page.getByText('能力进化', { exact: true }).first().click();
      const workspace = page.getByTestId('capability-evolution-workspace');
      await workspace.getByRole('button', { name: '查看进展', exact: true }).waitFor();
      report.measurements.liveRail = await workspace.boundingBox();
      await assertContained(workspace);
      await capture(page, 'live-home');
      await workspace.getByTestId(`capability-evolution-program-${PROGRAM_ID}`).click();
      const detail = page.getByTestId('capability-evolution-program-detail');
      if (liveAlpha) await detail.getByText('当前采用尚待资产来源确认。', { exact: true }).waitFor();
      else {
        await detail.getByText('官方 walking ONNX baseline', { exact: true }).waitFor();
        await detail.getByText(MICRODUCK_BASELINE_VERSION, { exact: true }).waitFor();
      }
      await capture(page, 'live-detail');
      await workspace.getByRole('button', { name: '展开阅读 →', exact: true }).click();
      const program = page.getByTestId('evolution-program-surface');
      await page.locator('[data-presentation="main-area-attention"]').waitFor();
      report.measurements.liveMain = await program.boundingBox();
      assert(report.measurements.liveMain.width > report.measurements.liveRail.width * 1.5);
      await assertContained(program);
      await capture(page, 'live-review');
      await program.getByRole('tab', { name: '更改历史' }).click();
      assert.equal(await program.getAttribute('data-reading-view'), 'history');
      assert.equal(await program.getByText('尚未收到绑定此版本的对照基线证据。', { exact: true }).count(), 0);
      if (liveAlpha) await program.getByText('暂时无法确认此版本的对照基线证据。', { exact: true }).waitFor();
      else {
        await program.getByText('官方 walking ONNX baseline', { exact: true }).first().waitFor();
        await program.getByText('本地 ONNX 61→14 推理 smoke 已通过；这不是步态鲁棒性评估。', { exact: true }).waitFor();
      }
      await capture(page, 'live-history');
      const initial = projection.program.sequence;
      const afterRead = await page.request.get(
        new URL(`/api/capability-evolution/programs/${encodeURIComponent(PROGRAM_ID)}`, base).href,
      );
      assert.equal((await afterRead.json()).program.sequence, initial, 'reading must not advance the Program');
      await page.getByTestId('f307-close-evolution-program').click();
      await page.locator('[data-presentation="right-rail"]').waitFor();
      assert.equal(await program.getAttribute('data-reading-view'), 'detail');
      await capture(page, 'live-close-return');
      await program.getByRole('button', { name: '← 全部项目', exact: true }).click();
      await workspace.getByTestId(`capability-evolution-program-${PROGRAM_ID}`).waitFor();
      await capture(page, 'live-all-projects-return');
      report.claims.push(
        `${liveAlpha ? 'Live Alpha owner read' : 'Synthetic Program read, not Alpha proof'}; one exact Program; no stage mutation; real F307 close returns to rail. No owner outcome or later use is asserted.`,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  'isolated Microduck owner materials remain readable before lineage and preserve exact candidate selection',
  { timeout: 90_000, skip: liveAlpha },
  async () => {
    const { page, context } = await authenticatedPage();
    try {
      const result = await verifyMicroduckPreparationReading({
        page,
        base,
        threadId,
        programId: PROGRAM_ID,
        navigateShell,
        ensureWorkspaceOpen,
        capture,
        assertContained,
        programWrites: fixture.programWrites,
        publishLatestPreparation: fixture.publishLatestPreparation,
        setPreparationMediaAvailable: fixture.setPreparationMediaAvailable,
      });
      report.measurements.microduckDesktop = result.desktop;
      report.measurements.microduckMobile = result.mobile;
      report.measurements.microduckPlayback = result.playback;
      report.claims.push(result.claim);
    } catch (error) {
      await capture(page, 'microduck-owner-candidate-failure');
      throw error;
    } finally {
      await context.close();
    }
  },
);

test('returning to all projects preserves the real Workspace sidecar', { timeout: 90_000 }, async () => {
  const { page, context } = await authenticatedPage();
  try {
    report.measurements.sidecarReturn = await verifyWorkspaceSidecarReturn(page, {
      threadUrl: new URL(`/thread/${threadId}`, base).href,
      programId: PROGRAM_ID,
      navigateShell,
      capture,
    });
    report.claims.push('Returning to a sidecar list preserves F307 layout, mounted owner DOM and home scroll.');
  } finally {
    await context.close();
  }
});

test(
  'contract fixtures exercise rich versions, evidence isolation, adoption updates and source priority inside the real shell',
  { timeout: 90_000 },
  async () => {
    const { page, context } = await authenticatedPage();
    try {
      const result = await verifyRichVersionReview({
        page,
        targetUrl,
        navigateShell,
        capture,
        assertContained,
        programFixture,
        assetReviewFixture,
      });
      report.measurements.narrowRail = result.narrowRail;
      report.measurements.mobileRail = result.mobileRail;
      report.measurements.compactRail = result.compactRail;
      report.claims.push(result.claim);
    } catch (error) {
      await capture(page, 'fixture-failure');
      console.error(await page.locator('body').innerText());
      throw error;
    } finally {
      await context.close();
    }
  },
);

test(
  'owner read failures retain exact navigation and recover without inventing absence',
  { timeout: 90_000 },
  async () => {
    const { page, context } = await authenticatedPage();
    const projection = programFixture('observing');
    projection.program.displayName = '契约样本 · 失败恢复';
    let mode = 'resolved';
    try {
      await page.route('**/api/capability-evolution/programs**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const asset = url.pathname.endsWith('/asset-review');
        if (mode === 'program-error' || (asset && mode === 'asset-error'))
          return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
        let body = projection;
        if (request.method() === 'POST') {
          assert(url.pathname.endsWith('/commands'));
          const command = request.postDataJSON();
          assert.equal(command.action.type, 'name');
          assert.equal(command.expectedSequence, projection.program.sequence);
          projection.program.displayName = command.action.displayName;
          projection.program.sequence += 1;
          body = { outcome: 'appended', projection };
        } else if (asset) {
          const selected = url.searchParams.get('selectedVersionRef');
          body = assetReviewFixture(selected ? JSON.parse(selected).version : 'v2');
        } else if (url.pathname.endsWith('/programs')) body = { programs: [projection] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await navigateShell(page, targetUrl('history', 'v1'));
      const program = page.getByTestId('evolution-program-surface');
      await program.getByText('v1 comparison_baseline', { exact: true }).waitFor();
      await program.getByText('修改项目名称', { exact: true }).click();
      await program.getByLabel('项目名称', { exact: true }).fill('契约样本 · 清晰讲解');
      await program.getByRole('button', { name: '保存名称', exact: true }).click();
      await program.getByRole('heading', { name: '契约样本 · 清晰讲解', exact: true }).waitFor();
      await page.getByTestId('f307-tab-evolution-program').getByText('契约样本 · 清晰讲解', { exact: true }).waitFor();
      await program.getByText('修改项目名称', { exact: true }).click();
      await capture(page, 'fixture-named-review');
      mode = 'asset-error';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await program.getByText('暂时无法确认此版本的对照基线证据。', { exact: true }).waitFor();
      assert.equal(await program.getByText('尚未收到绑定此版本的对照基线证据。', { exact: true }).count(), 0);
      const reading = await page.evaluate(
        () => JSON.parse(localStorage.getItem('f311-program-reading-v1')).state.programs,
      );
      assert.equal(reading[PROGRAM_ID].selectedVersionRef, undefined);
      await capture(page, 'fixture-asset-error');
      mode = 'program-error';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await program.getByRole('button', { name: '重试', exact: true }).waitFor();
      await program.getByRole('button', { name: '← 返回侧栏', exact: true }).waitFor();
      await assertContained(program);
      await capture(page, 'fixture-program-error');
      mode = 'resolved';
      await program.getByRole('button', { name: '重试', exact: true }).click();
      await program.getByRole('heading', { name: '契约样本 · 清晰讲解', exact: true }).waitFor();
      await program.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
      assert.equal(await program.getAttribute('data-reading-view'), 'detail');
      report.claims.push(
        'Contract-only: explicit canonical Program naming, authenticated read failure, local selection clearing, retained return and retry. No Alpha metadata or owner effects were changed.',
      );
    } finally {
      await context.close();
    }
  },
);
