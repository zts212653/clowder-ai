import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { verifyV2PreparationPages } from './f311-v2-preparation.journey.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

// The Workspace + entry is distinct from classic/deep-link and empty-list journeys.
// Share the existing product journey's Next/API/browser setup; isolate only the context.
const snapshots = JSON.parse(await readFile(new URL('./fixtures/f311-v2-program-snapshots.json', import.meta.url)));
const [f314, duck] = snapshots.programs;

async function workspaceHome(page) {
  await (await openWorkspaceTools(page)).getByTestId('workspace-launcher-capability-evolution').click();
  await page.getByTestId('capability-evolution-workspace').waitFor();
  assert.equal(page.url().includes('/settings'), false);
  await page.getByRole('tab', { name: '进化项目', exact: true }).waitFor();
}

export async function verifyV2EvolutionJourney({ fixture, browser, capture }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/eval-hub/summary', (route) =>
    route.fulfill({ json: { counts: { total: 0, actionable: 0, keepObserve: 0, stale: 0 }, domains: [], items: [] } }),
  );

  const writes = [];
  await context.route('**/api/messages', (route) => {
    if (route.request().method() === 'GET') return route.continue();
    writes.push({ method: route.request().method(), path: '/api/messages' });
    return route.fulfill({ status: 405, json: { error: 'unsent_goal_contract' } });
  });
  await context.route('**/api/capability-evolution/programs**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), path: url.pathname });
      return route.fulfill({ status: 405, json: { error: 'read_only_snapshot' } });
    }
    if (url.pathname === '/api/capability-evolution/programs')
      return route.fulfill({
        json: { programs: snapshots.programs.map(({ preparation: _preparation, ...projection }) => projection) },
      });
    for (const projection of snapshots.programs) {
      const path = `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}`;
      if (url.pathname === path) return route.fulfill({ json: projection });
      if (url.pathname === `${path}/asset-review` || url.pathname === `${path}/preparation-review`)
        return route.fulfill({
          json: {
            schemaVersion: 1,
            status: 'unavailable',
            programRef: { ownerFeatureId: 'F311', ownerStateRef: projection.program.programId },
            objectRef: projection.program.objectRef,
            blockers: [{ code: 'owner_read_unavailable', ownerRef: projection.program.objectRef }],
          },
        });
    }
    return route.continue();
  });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${fixture.apiUrl}/api/session`);
    await page.goto(`${fixture.webUrl}/thread/${CONTRACT_THREAD_ID}?shell=v2`);
    await workspaceHome(page);
    const home = page.getByTestId('capability-evolution-workspace');
    await home.getByTestId(`capability-evolution-program-${duck.program.programId}`).waitFor();
    assert.ok((await home.innerText()).includes('尚未命名'));
    assert.ok((await home.innerText()).includes(f314.origin.title));
    assert.ok((await home.innerText()).includes('这一阶段还缺'));
    assert.ok((await home.innerText()).includes('谁在做'));
    assert.ok((await home.innerText()).includes('当前活动未知'));
    const composer = page.getByTestId('chat-input-composer-row').locator('textarea');
    await composer.fill('原有未发送草稿');
    await home.getByRole('button', { name: '新建目标', exact: true }).click();
    await home.getByTestId('capability-evolution-start-input').fill('F311 新版目标草稿');
    await home.getByTestId('capability-evolution-start').click();
    await home.getByText(/原有草稿已保留/).waitFor();
    assert.ok((await composer.inputValue()).includes('原有未发送草稿'));
    assert.ok((await composer.inputValue()).includes('我们来进化 F311 新版目标草稿'));
    await home.getByRole('button', { name: '新建目标', exact: true }).click();
    await capture(page, 's1-home');
    await home.getByRole('tab', { name: '评估', exact: true }).click();
    await page.getByTestId('eval-workspace-panel').waitFor();
    await home.getByRole('tab', { name: '进化项目', exact: true }).click();
    for (const [label, projection] of [
      ['f314', f314],
      ['duck', duck],
    ]) {
      await home.getByTestId(`capability-evolution-program-${projection.program.programId}`).click();
      const detail = home.getByTestId('capability-evolution-program-detail');
      await detail.getByRole('link', { name: `回到发起对话「${projection.origin.title}」 ↗` }).waitFor();
      assert.ok((await detail.innerText()).includes('当前采用'));
      assert.ok((await detail.innerText()).includes('本轮候选'));
      assert.ok(
        (await detail.innerText()).includes('修改项目名称') || (await detail.innerText()).includes('补充项目名称'),
      );
      await detail.getByRole('button', { name: '准备', exact: true }).click();
      const overview = detail.getByRole('region', { name: '准备四块总览' });
      await overview.waitFor();
      assert.equal(await overview.locator('[data-preparation-overview]').count(), 4);
      assert.ok((await overview.innerText()).includes('草案 · 不等于验证'));
      assert.equal(
        await detail.getByTestId('evolution-preparation-workspace').count(),
        0,
        'full body belongs in main reading',
      );
      await capture(page, `s1-${label}-detail`);
      await overview.locator('[data-preparation-overview="object_map"]').click();
      const main = page.locator('[data-testid="evolution-program-surface"]:visible');
      const reading = main.getByTestId('evolution-preparation-workspace');
      await reading.waitFor();
      await reading
        .getByText(projection.preparation.sections.object_map.current.submission.body.summary, { exact: true })
        .waitFor();
      const objects = projection.preparation.sections.object_map.current.submission.body.items;
      assert.equal(await reading.locator('[data-preparation-item]').count(), objects.length);
      await capture(page, `s1-${label}-main`);
      await verifyV2PreparationPages({ page, main, projection, capture, label });
      await main.getByRole('button', { name: '← 返回侧栏', exact: true }).click();
      // An explicit Workspace home intent overrides restored detail selection.
      await workspaceHome(page);
      await home.getByTestId(`capability-evolution-program-${projection.program.programId}`).waitFor();
    }
    for (const width of [416, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await home.getByTestId(`capability-evolution-program-${duck.program.programId}`).click();
      const detail = home.getByTestId('capability-evolution-program-detail');
      await detail.getByRole('button', { name: '准备', exact: true }).click();
      await detail.getByRole('region', { name: '准备四块总览' }).waitFor();
      const overflow = await home.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
      assert.equal(overflow, false, `v2 project page must fit ${width}px`);
      await capture(page, `s1-duck-${width}`);
      await detail.locator('[data-preparation-overview="object_map"]').click();
      const main = page.locator('[data-testid="evolution-program-surface"]:visible');
      await main.getByTestId('evolution-preparation-workspace').waitFor();
      assert.equal(
        await main.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
        false,
        `preparation must fit ${width}px`,
      );
      await main.locator('.evolution-preparation-submission').scrollIntoViewIfNeeded();
      await capture(page, `s2-duck-main-${width}`);
      await main.getByRole('button', { name: /← 返回侧栏|← 返回详情/ }).click();
      await main.getByRole('button', { name: '← 全部项目', exact: true }).click();
    }
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(() => {
      localStorage.setItem('theme', 'dark');
    });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await home.getByTestId(`capability-evolution-program-${duck.program.programId}`).waitFor();
    await capture(page, 's1-dark');
    await home.getByTestId(`capability-evolution-program-${duck.program.programId}`).click();
    const darkDetail = home.getByTestId('capability-evolution-program-detail');
    await darkDetail.getByRole('button', { name: '准备', exact: true }).click();
    await darkDetail.locator('[data-preparation-overview="object_map"]').click();
    await page
      .locator('[data-testid="evolution-program-surface"]:visible')
      .getByTestId('evolution-preparation-workspace')
      .waitFor();
    await page
      .locator('[data-testid="evolution-program-surface"]:visible .evolution-preparation-submission')
      .scrollIntoViewIfNeeded();
    await capture(page, 's2-dark-main');
    assert.deepEqual(errors, []);
  } catch (error) {
    await capture(page, 's1-failure');
    const diagnostics = await page.evaluate(() => {
      const target = document.querySelector('[data-testid="capability-evolution-workspace"]');
      const ancestors = [];
      for (let node = target; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestors.push({
          testid: node.dataset.testid,
          className: node.className,
          display: style.display,
          width: node.clientWidth,
          height: node.clientHeight,
        });
      }
      return {
        url: location.href,
        ancestors,
        owners: [...document.querySelectorAll('[data-active-surface],[data-presentation]')].map((node) => ({
          ...node.dataset,
        })),
      };
    });
    console.error(JSON.stringify(diagnostics));
    throw error;
  } finally {
    await context.close();
    assert.deepEqual(writes, [], 'reading must not mutate either snapshot Program');
  }
}
