import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';

/** Keep the actual Markdown links, file-stamp consumer, owner renderer, tabs and persistence. */
export function registerChatFileTabJourneys(getSuite) {
  for (const presentation of ['classic', 'v2']) {
    test(
      `${presentation} chat document links retain their tabs across clicks and reload`,
      { timeout: 120_000 },
      async () => {
        const { browser, baseUrl, evidenceDir } = getSuite();
        for (const width of [1440, 390]) {
          const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
          const errors = [];
          const fileRequests = [];
          await context.addInitScript(() => {
            if (sessionStorage.getItem('file-tabs-initialized')) return;
            localStorage.clear();
            sessionStorage.setItem('file-tabs-initialized', '1');
          });
          const page = await context.newPage();
          page.on('pageerror', (error) => errors.push(error.message));
          await page.route('**/api/**', (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const result =
              url.pathname === '/api/messages'
                ? {
                    body: {
                      messages: [
                        {
                          from: { kind: 'agent', catId: 'codex-sol' },
                          id: 'file-tab-source',
                          type: 'assistant',
                          catId: 'codex-sol',
                          timestamp: 100,
                          content:
                            '[Document A](README.md)\n\n[Document B](docs/README.md:7)\n\n[B line 12](docs/README.md:12)',
                        },
                      ],
                      hasMore: false,
                    },
                  }
                : realSurfaceApiResponse(request, false);
            if (url.pathname === '/api/workspace/resolve-file-source') {
              fileRequests.push({ input: request.postDataJSON(), status: result.status ?? 200, body: result.body });
            }
            return route.fulfill({
              status: result.status ?? 200,
              contentType: 'application/json',
              body: JSON.stringify(result.body),
            });
          });
          const layout = () => page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2')));
          const paths = (state) => state.surfaces.map((surface) => surface.context);
          const workbench = page.getByTestId('f307-experience-workbench');
          const clickLink = async (label, count) => {
            if (width === 390 && (await workbench.isVisible())) {
              if (presentation === 'v2') {
                await workbench.locator('[data-testid="v2-workspace-actions"] summary').last().click();
                await page.getByRole('menuitem', { name: '收起 Workspace', exact: true }).click();
              } else {
                await page
                  .getByTestId('contextual-workspace-host')
                  .getByRole('button', { name: '收起 Workspace', exact: true })
                  .click();
              }
              await workbench.waitFor({ state: 'hidden' });
            }
            await page
              .locator('[data-message-id="file-tab-source"]')
              .getByRole('button', { name: label, exact: true })
              .click();
            await workbench.waitFor();
            await page.waitForFunction((expected) => {
              const state = JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2'));
              const active = state?.surfaces.find((surface) => surface.id === state.activeSurfaceId);
              return state?.surfaces.length === expected && /^f063_root_v1_/.test(active?.ownerStateRef.key ?? '');
            }, count);
          };
          try {
            await page.goto(`${baseUrl}?shell=${presentation}`, { waitUntil: 'domcontentloaded' });
            await clickLink('Document A', 1);
            const a = (await layout()).surfaces[0];
            await clickLink('Document B', 2);
            const both = await layout();
            assert.deepEqual(paths(both), ['README.md', 'docs/README.md']);
            assert.deepEqual(both.surfaces[0], a);
            assert.equal(both.previewSurfaceId, null);
            const b = both.surfaces[1];
            await clickLink('B line 12', 2);
            await page.waitForFunction(
              (oldTarget) =>
                JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2')).surfaces[1].resultTargetRef.key !==
                oldTarget,
              b.resultTargetRef.key,
            );
            assert.deepEqual(paths(await layout()), ['README.md', 'docs/README.md']);
            assert.equal((await layout()).activeSurfaceId, b.id);
            const more = workbench.getByTestId('v2-more-tabs');
            const overflowVisible = presentation === 'v2' && (await more.isVisible());
            if (overflowVisible) {
              await more.click();
              const popupId = await more.getAttribute('aria-controls');
              assert.ok(popupId, 'Wait for this original disclosure, not another portal');
              await page
                .locator(`[id="${popupId}"] [data-workbench-tab-control="activate"]`)
                .first()
                .waitFor({ state: 'visible' });
            }
            const controls = page.locator('[data-tab-surface-id] [data-workbench-tab-control="activate"]:visible');
            assert.deepEqual((await controls.allTextContents()).map((text) => text.trim()).sort(), [
              'README.md',
              'docs/README.md',
            ]);
            for (const [id, name] of [
              [a.id, 'README.md'],
              [b.id, 'docs/README.md'],
            ]) {
              const block = page.locator(`[data-tab-surface-id="${id}"]:visible`);
              assert.equal(await block.locator('[data-workbench-tab-control="activate"]').innerText(), name);
              assert.ok(
                (await block.locator('[data-workbench-tab-control="close"]').getAttribute('aria-label')).includes(name),
              );
            }
            await page.screenshot({
              path: path.join(evidenceDir, `chat-file-tab-labels-${presentation}-${width}.png`),
            });
            if (overflowVisible) await page.keyboard.press('Escape');
            await page.screenshot({ path: path.join(evidenceDir, `chat-file-tabs-${presentation}-${width}.png`) });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await workbench.waitFor();
            await page.waitForFunction(
              () =>
                document
                  .querySelector('[data-testid="f307-experience-workbench"]')
                  ?.getAttribute('data-surface-count') === '2',
            );
            assert.deepEqual(paths(await layout()), ['README.md', 'docs/README.md']);
            assert.deepEqual(errors, []);
          } catch (error) {
            const diagnostic = {
              layout: await layout(),
              fileRequests,
              errors,
              alerts: await page.getByRole('alert').allTextContents(),
            };
            const name = `chat-file-tabs-${presentation}-${width}-failed`;
            await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
            await writeFile(path.join(evidenceDir, `${name}.json`), JSON.stringify(diagnostic, null, 2));
            console.error(`${name}: ${JSON.stringify(diagnostic)}`);
            throw error;
          } finally {
            await context.close();
          }
        }
      },
    );
  }
}
