import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

/** One real Chat journey. Surrounding account/Queue transport is isolated; service and response writer are real. */
export function registerCodexStartupJourney({ preview, browser }) {
  test(
    'Codex startup recovery keeps its original reply through live, background and refreshed Chat',
    { timeout: 120_000 },
    async () => {
      const p = preview();
      if (process.env.F320_EVIDENCE_DIR) {
        await mkdir(process.env.F320_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.F320_EVIDENCE_DIR, 'startup-preview.json'),
          JSON.stringify(
            {
              worktree: new URL('../../../../', import.meta.url).pathname,
              webUrl: p.url,
              apiUrl: p.apiUrl,
              route: `/thread/${p.threadId}?shell=v2`,
              nativePeer: 'isolated fake wire; real service, routes, original response writer and Chat',
              realOAuth: false,
            },
            null,
            2,
          ),
        );
      }
      const page = await browser().newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') console.log('startup browser console:', message.text().slice(0, 500));
      });
      const screenshot = async (name) => {
        if (!process.env.F320_EVIDENCE_DIR) return;
        await mkdir(process.env.F320_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.F320_EVIDENCE_DIR, name), fullPage: true });
      };
      const read = async (id) => (await page.request.get(`${p.apiUrl}/api/fixture/startup/${id}`)).json();
      try {
        await page.goto(`${p.url}/thread/${p.threadId}?shell=v2`, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('chat-input-composer-row').waitFor();
        const started = await (
          await page.request.post(`${p.apiUrl}/api/fixture/startup`, { data: { origin: 'user', scenario: 'recover' } })
        ).json();
        let initial = await read(started.runId);
        const initialDeadline = Date.now() + 5_000;
        while (!initial.response && !initial.error && !initial.errors?.length && Date.now() < initialDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          initial = await read(started.runId);
        }
        assert.equal(initial.error, undefined, JSON.stringify(initial));
        assert.deepEqual(initial.errors, [], JSON.stringify(initial));
        await page.getByTestId('codex-startup-recovery').filter({ hasText: '正在自动重试' }).waitFor();
        const first = await read(started.runId);
        assert.equal(first.turnStarts, 0);
        const responseId = first.response.id;
        await screenshot('startup-retry-desktop.png');
        await page.reload({ waitUntil: 'domcontentloaded' });
        const reply = page.locator(`[data-message-id="${responseId}"]`);
        await reply.getByTestId('codex-startup-recovery').waitFor();
        await reply.getByText('Original task completed.', { exact: false }).waitFor();
        assert.doesNotMatch(await reply.innerText(), /账号确认已恢复/);
        await reply.getByTestId('reply-record-toggle').click();
        await reply
          .getByTestId('startup-recovered-record')
          .getByText('账号确认已恢复，尝试 3 次', { exact: true })
          .waitFor();
        assert.equal(await reply.getByTestId('cli-diagnostics-toggle').count(), 0);
        assert.equal((await read(started.runId)).turnStarts, 1);
        await screenshot('startup-recovered-desktop.png');
        const failed = await (
          await page.request.post(`${p.apiUrl}/api/fixture/startup`, {
            data: { origin: 'system_wake', scenario: 'fail', mode: 'parallel' },
          })
        ).json();
        await page.getByTestId('codex-startup-recovery').filter({ hasText: '正在自动重试' }).waitFor();
        await page.goto(`${p.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
        const deadline = Date.now() + 20_000;
        let final;
        do {
          final = await read(failed.runId);
          if (final.response?.lifecycle.status === 'failed') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.equal(final.response?.lifecycle.status, 'failed', JSON.stringify(final));
        assert.equal(final.wireCount, 6);
        assert.equal(final.turnStarts, 0);
        await page.goto(`${p.url}/thread/${p.threadId}?shell=v2`, { waitUntil: 'domcontentloaded' });
        const failure = page.locator(`[data-message-id="${final.response.id}"]`);
        await failure.getByText(/已尝试 6 次.*本次任务尚未开始/).waitFor();
        assert.equal(await failure.getByText('workspace routing discovery failed', { exact: true }).count(), 0);
        await failure.getByTestId('cli-diagnostics-toggle').click();
        await failure
          .getByTestId('cli-diagnostics-excerpt')
          .getByText('workspace routing discovery failed', { exact: true })
          .waitFor();
        assert.match(await failure.innerText(), /JSON-RPC code: -32603/);
        assert.doesNotMatch(await failure.innerText(), /HTTP status: -32603/);
        await screenshot('startup-failed-details-desktop.png');
        await page.setViewportSize({ width: 390, height: 844 });
        const backdrop = page.locator('[class*="console-overlay-backdrop"][aria-hidden="true"]');
        if (await backdrop.count()) await backdrop.click({ position: { x: 350, y: 60 } });
        await page.evaluate(() => {
          localStorage.setItem('cat-cafe:shell-language', 'en');
          window.dispatchEvent(new CustomEvent('cat-cafe:shell-language-sync'));
        });
        await failure.getByText(/Unable to confirm the Codex account after 6 attempts/).waitFor();
        assert.equal(await failure.locator('[data-testid="cli-diagnostics-banner"]').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await screenshot('startup-failed-mobile-en.png');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await failure.getByText(/Unable to confirm the Codex account after 6 attempts/).waitFor();
        await failure.getByRole('button', { name: 'View error details', exact: true }).click();
        await failure.getByTestId('cli-diagnostics-excerpt').waitFor();
        await failure.getByTestId('cli-diagnostics-excerpt').scrollIntoViewIfNeeded();
        await screenshot('startup-failed-mobile-en-restored.png');
        assert.equal(await failure.count(), 1);
        assert.deepEqual(errors, []);
      } catch (error) {
        console.log(
          'startup route evidence:',
          p.startup.runs.map((run) => ({
            error: run.error,
            events: run.events.filter((event) => event.type === 'error'),
            response: p.startup.store.getById(run.responseId),
          })),
        );
        await screenshot('startup-browser-failure.png');
        console.log('startup browser visible:', (await page.locator('body').innerText()).slice(-3000));
        throw error;
      } finally {
        await page.close();
      }
    },
  );
}
