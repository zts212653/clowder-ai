import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { createWorkspaceV3Fixture, WORKSPACE_SAMPLE_THREAD } from './f322-b-workspace-v3-fixture.mjs';

const summary = {
  generatedAt: '2026-10-13T00:00:00Z',
  counts: { total: 0, actionable: 0, keepObserve: 0, stale: 0, registeredDomains: 1 },
  domains: [
    {
      domainId: 'eval:controlled',
      displayName: 'Controlled periodic evaluation',
      systemThreadId: WORKSPACE_SAMPLE_THREAD,
      frequency: 'daily',
      evalCatId: 'codex61-sol',
      evalCatHandle: '@codex61-sol',
      enabled: true,
      hasVerdict: false,
      nextCronFireAt: '2030-01-01T00:00:00Z',
    },
  ],
  items: [],
};
const scheduledTask = {
  id: 'controlled-schedule',
  profile: 'controlled',
  trigger: { type: 'interval', ms: 3600000 },
  enabled: true,
  lastRun: null,
  runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 },
  display: { label: 'Controlled scheduled task', category: 'system' },
  subjectPreview: null,
  source: 'builtin',
};

export function registerToolsEntryJourneys(getSuite) {
  for (const language of ['zh', 'en']) {
    test(`F322 tools direct owners ${language}`, async () => {
      const suite = getSuite();
      const output = process.env.F322_TOOLS_EVIDENCE_DIR ?? '/tmp/f322-tools-entry';
      await mkdir(output, { recursive: true });
      const context = await suite.browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript((language) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
      }, language);
      const page = await context.newPage();
      const fixture = createWorkspaceV3Fixture();
      const errors = [];
      let failure;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const bodies = {
          '/api/eval-hub/summary': summary,
          '/api/schedule/tasks': { tasks: [scheduledTask] },
          '/api/schedule/control': { global: null },
          '/api/community-repos': { repos: ['controlled/readonly'] },
          '/api/community-board': { repo: 'controlled/readonly', issues: [], prItems: [] },
          '/api/community-findings': { findings: [] },
          '/api/community-decision-queue': { items: [] },
          '/api/capability-evolution/programs': { programs: [] },
        };
        if (!(path in bodies)) return fixture.answer(route);
        fixture.calls.push({ path, method: request.method(), body: request.postData() });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bodies[path]) });
      });
      try {
        await page.goto(new URL(`/thread/${WORKSPACE_SAMPLE_THREAD}`, suite.baseUrl).href);
        const field = page.getByTestId('chat-input-composer-row').locator('textarea');
        await field.fill('Controlled tools draft');
        await field.evaluate((el) => el.setSelectionRange(3, 8));
        await ensureWorkspaceOpen(page);
        const tools = page.getByTestId('workspace-tools-content');
        const openTools = async () => {
          await page.getByTestId('v2-workspace-tools').click();
          await tools.waitFor();
          await tools.getByTestId('workspace-launcher-search').fill('');
        };
        const owner = page.getByTestId('f307-experience-workbench');
        await openTools();
        // First visit has no recent records: these are ordinary catalogue entries.
        assert.equal(await tools.getByTestId('workspace-tool-recent').count(), 0);
        for (const id of ['mode:schedule', 'mode:eval', 'mode:community', 'workspace:capability-evolution']) {
          assert.equal(await tools.locator(`.home-tool-grid [data-workspace-destination="${id}"]`).count(), 1);
        }
        await page.screenshot({ path: `${output}/${language}-default-tools.png` });
        await tools.locator('[data-workspace-destination="mode:schedule"]').click();
        await page.getByText('Controlled scheduled task', { exact: true }).waitFor();
        assert.equal(await owner.getAttribute('data-active-surface'), 'workspace:mode:schedule');
        assert.equal(await tools.isVisible(), false);
        await openTools();
        // Search the other language, still using the same catalogue and original destination.
        await tools.getByTestId('workspace-launcher-search').fill(language === 'en' ? '评估' : 'evaluations');
        await tools.locator('[data-workspace-destination="mode:eval"]').click();
        const evalPanel = page.getByTestId('eval-workspace-panel');
        await evalPanel.waitFor();
        assert.equal(await owner.getAttribute('data-active-surface'), 'workspace:mode:eval');
        await evalPanel.getByTestId('eval-open-ledger').click();
        const ledger = evalPanel.getByTestId('eval-workspace-ledger');
        await ledger.getByText('Controlled periodic evaluation', { exact: true }).waitFor();
        assert.ok((await ledger.innerText()).includes(language === 'en' ? 'Next evaluation' : '下次评估'));
        assert.ok((await ledger.innerText()).includes('daily'));
        assert.equal(page.url().includes('/settings'), false);
        await page.screenshot({ path: `${output}/${language}-periodic-ledger.png` });
        await evalPanel.getByTestId('eval-open-ledger').click();
        assert.equal(await ledger.isVisible(), false);
        await openTools();
        await tools.locator('[data-workspace-destination="mode:community"]').click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-active-surface') ===
            'workspace:mode:community',
        );
        await openTools();
        await tools.locator('[data-workspace-destination="workspace:capability-evolution"]').click();
        await page.getByTestId('capability-evolution-workspace').waitFor();
        assert.equal(await page.getByTestId('f307-workspace-home-page').isVisible(), false);
        await page.getByTestId('v2-workspace-home').click();
        await page.getByTestId('f307-workspace-home-page').waitFor();
        assert.equal(await field.inputValue(), 'Controlled tools draft');
        assert.deepEqual(await field.evaluate((el) => [el.selectionStart, el.selectionEnd]), [3, 8]);
        assert.equal(page.url().includes('/settings'), false);
        for (const path of [
          '/api/schedule/tasks',
          '/api/eval-hub/summary',
          '/api/community-repos',
          '/api/capability-evolution/programs',
        ])
          assert.ok(fixture.calls.some((call) => call.path === path && call.method === 'GET'));
        assert.equal(
          fixture.calls.some((call) => call.method === 'POST' && call.path === '/api/messages'),
          false,
        );
        assert.deepEqual(errors, []);
      } catch (error) {
        failure = { message: error.message, stack: error.stack };
        throw error;
      } finally {
        await writeFile(
          `${output}/${language}-calls.json`,
          JSON.stringify({ failure, errors, calls: fixture.calls }, null, 2),
        );
        await page.screenshot({ path: `${output}/${language}-final.png` }).catch(() => {});
        await context.close();
      }
    });
  }
}
