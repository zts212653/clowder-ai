import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerAccountabilityMailboxJourney } from './f290-accountability-mailbox.journey.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { registerProjectAuthoringJourney } from './f290-project-authoring.journey.mjs';
import { seedRoadmaps } from './f290-roadmap-workspace.fixture.mjs';

registerProjectAuthoringJourney();
registerAccountabilityMailboxJourney();

test(
  'Project keeps one Task truth across overview, board, Project plan, context, source return, and mobile',
  { timeout: 60_000 },
  async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-u3-roadmap-data-'));
    const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'f290-u3-roadmap-evidence-'));
    const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: defaultHumanAuthProvider() });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const records = await seedRoadmaps(opened.store, seeded);
    const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript(
      ({ origin, sessionToken }) => sessionStorage.setItem(`collective-session:${origin}`, sessionToken),
      { origin: server.url, sessionToken: seeded.owner.sessionToken },
    );
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await page
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await page.getByRole('button', { name: '项目', exact: true }).click();

      const projectList = page.getByRole('region', { name: '项目列表', exact: true });
      await projectList.waitFor();
      assert.equal(await page.locator('.scene-header').count(), 0, 'Project replaces the channel-style header');
      assert.deepEqual(await page.getByRole('navigation', { name: '项目视图' }).getByRole('button').allTextContents(), [
        '项目列表',
        '跨项目依赖',
        '看板',
      ]);
      assert.deepEqual(
        await page.getByRole('navigation', { name: '项目列表筛选' }).getByRole('button').allTextContents(),
        ['进行中 2', '与我相关 2', '有阻塞 1'],
      );
      assert.equal(await projectList.locator('[data-project-id]').count(), 2, 'completed Projects start folded');
      assert.equal(await page.getByRole('region', { name: '项目待办', exact: true }).count(), 1);
      await projectList.getByText(`等待 ${records.prerequisite.title}`, { exact: true }).waitFor();
      assert.equal(await projectList.getByText('继续推进', { exact: true }).count(), 0);

      await page.getByRole('group', { name: '项目列表显示设置' }).locator('summary').click();
      await page.getByLabel('显示已完成项目', { exact: true }).check();
      await page.getByRole('group', { name: '已完成项目' }).locator('summary').click();
      await projectList.locator(`[data-project-id="${records.followup.roadmapId}"]`).waitFor();
      await page.getByRole('group', { name: '项目列表显示设置' }).locator('summary').click();
      await page.screenshot({
        path: path.join(evidenceDirectory, 'u3-project-list-desktop-1440.png'),
        fullPage: true,
      });

      const workIds = (locator) =>
        locator
          .locator('[data-roadmap-work-id]')
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.roadmapWorkId));

      await page.getByRole('button', { name: '看板', exact: true }).click();
      const projectBoard = page.getByRole('region', { name: '项目看板', exact: true });
      await projectBoard.waitFor();
      assert.equal(await page.getByRole('region', { name: '项目待办', exact: true }).count(), 0);
      const globalTaskAction = page.getByRole('button', { name: '新建任务', exact: true });
      assert.equal(await globalTaskAction.count(), 1);
      const globalTaskActionStyle = await globalTaskAction.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          minHeight: style.minHeight,
          padding: style.padding,
          borderRadius: style.borderRadius,
          fontSize: style.fontSize,
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderTopColor: style.borderTopColor,
        };
      });
      assert.notEqual(
        globalTaskActionStyle.backgroundColor,
        'rgba(0, 0, 0, 0)',
        'the canonical primary Task action keeps a filled background',
      );
      assert.equal(
        globalTaskActionStyle.borderTopColor,
        globalTaskActionStyle.backgroundColor,
        'the canonical primary Task action uses one accent for fill and border',
      );
      assert.deepEqual(
        await projectBoard.getByRole('navigation', { name: '看板筛选' }).getByRole('button').allTextContents(),
        ['全部任务 6', '与我相关 5', '被阻塞 1', '待确认 1'],
      );
      assert.equal((await workIds(projectBoard)).length, 6, 'shared tasks appear once across projects');
      assert.equal(new Set(await workIds(projectBoard)).size, 6);
      assert.equal(await projectBoard.locator('[data-project-lane]').first().getAttribute('data-unassigned'), 'true');
      assert.ok(await projectBoard.locator('[data-identity-kind="agent"]').count());
      assert.ok(await projectBoard.locator('[data-identity-kind="human"]').count());
      assert.equal(await projectBoard.getByRole('group', { name: '看板显示设置' }).count(), 1);
      await page.screenshot({
        path: path.join(evidenceDirectory, 'u3-project-board-desktop-1440.png'),
        fullPage: true,
      });
      const lightCardSurface = await projectBoard
        .locator('.project-board-card')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
      });
      const darkCardSurface = await projectBoard
        .locator('.project-board-card')
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      assert.notEqual(darkCardSurface, lightCardSurface, 'the board consumes shared dark theme tokens');
      await page.evaluate(() => {
        delete document.documentElement.dataset.theme;
      });

      const unassignedCard = projectBoard.locator(`[data-roadmap-work-id="${records.unassigned.workId}"]`);
      await unassignedCard.getByRole('button', { name: new RegExp(records.unassigned.title) }).click();
      const plan = page.getByRole('region', { name: '项目任务计划', exact: true });
      await plan.waitFor();
      assert.equal(await page.getByRole('navigation', { name: '项目视图' }).count(), 0);
      assert.equal(await page.getByRole('region', { name: '项目待办', exact: true }).count(), 0);
      assert.deepEqual(
        await page.getByRole('navigation', { name: '项目观察方式' }).getByRole('button').allTextContents(),
        ['计划', '看板', '依赖图', '作品'],
      );
      const projectTaskAction = page.getByRole('button', { name: '新建任务', exact: true });
      assert.equal(await projectTaskAction.count(), 1);
      assert.deepEqual(
        await projectTaskAction.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            minHeight: style.minHeight,
            padding: style.padding,
            borderRadius: style.borderRadius,
            fontSize: style.fontSize,
            backgroundColor: style.backgroundColor,
            color: style.color,
            borderTopColor: style.borderTopColor,
          };
        }),
        globalTaskActionStyle,
        'single-Project and global Task creation keep the same compact primary-action geometry and color',
      );
      assert.deepEqual(await page.getByRole('group', { name: '项目筛选' }).getByRole('button').allTextContents(), [
        '全部 5',
        '未完成 4',
        '与我相关 4',
      ]);
      assert.equal(await plan.locator('[data-project-plan-work-id]').count(), 5);
      assert.deepEqual(await plan.locator('.project-plan-columns > span').allTextContents(), [
        '任务',
        '执行',
        '阻塞 / 前置',
        '下一次交付',
        '最近',
      ]);
      await page.getByRole('complementary', { name: `任务详情 · ${records.unassigned.title}`, exact: true }).waitFor();

      const projectContext = page.getByRole('complementary', { name: '项目上下文与动态', exact: true });
      await projectContext.getByText('猫接手这个项目的任务时，先读到这些', { exact: true }).waitFor();
      await projectContext.getByText(records.primary.purpose, { exact: true }).waitFor();
      await projectContext.getByText('重新打开了项目', { exact: true }).waitFor();
      assert.equal(await projectContext.getByText('今天已冻结', { exact: true }).count(), 0);
      await page
        .getByRole('complementary', { name: `任务详情 · ${records.unassigned.title}`, exact: true })
        .getByRole('button', { name: '关闭任务详情', exact: true })
        .click();
      await page.screenshot({
        path: path.join(evidenceDirectory, 'u3-project-plan-context-desktop-1440.png'),
        fullPage: true,
      });

      await page.getByRole('navigation', { name: '项目观察方式' }).getByRole('button', { name: '看板' }).click();
      const singleProjectBoard = page.getByRole('region', { name: '项目看板', exact: true });
      assert.equal((await workIds(singleProjectBoard)).length, 5);

      await page.getByRole('navigation', { name: '项目层级' }).getByRole('button', { name: '项目' }).click();
      await page.getByRole('button', { name: '跨项目依赖', exact: true }).click();
      const projectDependencies = page.getByRole('region', { name: '任务依赖图', exact: true });
      assert.equal((await workIds(projectDependencies)).length, 6);
      assert.equal(new Set(await workIds(projectDependencies)).size, 6);

      await page.getByRole('button', { name: '项目列表', exact: true }).click();
      await projectList.getByRole('button', { name: new RegExp(records.primary.title) }).click();
      await page.getByRole('navigation', { name: '项目观察方式' }).getByRole('button', { name: '依赖图' }).click();
      const graph = page.getByRole('region', { name: '任务依赖图', exact: true });
      assert.equal((await workIds(graph)).length, 5);
      await graph
        .locator(`[data-roadmap-work-id="${records.mobile.workId}"]`)
        .getByText(`等待 ${records.prerequisite.title}`, { exact: true })
        .waitFor();
      await graph.getByRole('button', { name: new RegExp(records.mobile.title) }).click();
      const inspector = page.getByRole('complementary', { name: `任务详情 · ${records.mobile.title}`, exact: true });
      await inspector.getByText('You 负责', { exact: true }).waitFor();
      await inspector.getByText('小星星 · 砚砚 推进', { exact: true }).waitFor();
      await inspector.getByText('#插件共建 · 话题', { exact: true }).waitFor();
      await inspector.getByText(`${records.prerequisite.title}（#产品方向）`, { exact: true }).waitFor();
      assert.equal(
        await graph.locator(`[data-roadmap-work-id="${records.prerequisite.workId}"]`).count(),
        0,
        'an authorized external prerequisite resolves without becoming a Project member',
      );

      await inspector.getByRole('button', { name: '查看来源消息', exact: true }).click();
      await page.getByRole('heading', { name: '# 插件共建', exact: true }).waitFor();
      await page
        .locator(`[data-event-id="${records.mobileSource.eventId}"]`)
        .locator('.topic-message .message-body')
        .getByText(records.mobileSource.body, { exact: true })
        .waitFor();
      await page.getByRole('button', { name: `← 返回 ${records.primary.title}`, exact: true }).click();
      await page.getByRole('navigation', { name: '项目层级' }).waitFor();
      await page.getByRole('complementary', { name: `任务详情 · ${records.mobile.title}`, exact: true }).waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.getByRole('button', { name: '频道导航', exact: true }).count(), 1);
      assert.deepEqual(
        await page.getByRole('button', { name: '新建任务', exact: true }).evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            minHeight: style.minHeight,
            padding: style.padding,
            borderRadius: style.borderRadius,
            fontSize: style.fontSize,
            backgroundColor: style.backgroundColor,
            color: style.color,
            borderTopColor: style.borderTopColor,
          };
        }),
        globalTaskActionStyle,
        'mobile single-Project Task creation keeps the compact primary-action geometry and color',
      );
      const mobileInspector = page.getByRole('complementary', {
        name: `任务详情 · ${records.mobile.title}`,
        exact: true,
      });
      const inspectorBox = await mobileInspector.boundingBox();
      assert.ok(inspectorBox && inspectorBox.x >= 0 && inspectorBox.x + inspectorBox.width <= 390);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: path.join(evidenceDirectory, 'u3-project-detail-mobile-390.png'), fullPage: true });

      await mobileInspector.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await page.getByRole('navigation', { name: '项目观察方式' }).getByRole('button', { name: '计划' }).click();
      const mobilePlan = page.getByRole('region', { name: '项目任务计划', exact: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(
        await mobilePlan
          .locator('[data-project-plan-work-id]')
          .first()
          .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length),
        1,
      );
      await page.screenshot({ path: path.join(evidenceDirectory, 'u3-project-plan-mobile-390.png'), fullPage: true });

      const projection = opened.store.listCollectiveCollaboration(
        seeded.owner.sessionToken,
        seeded.coordinates.collectiveId,
      );
      assert.equal(projection.roadmaps.length, 3);
      assert.equal(
        projection.roadmaps.find((item) => item.roadmapId === records.primary.roadmapId)?.history.at(-2)?.action,
        'reopened',
      );
      assert.deepEqual(pageErrors, []);
      console.log(
        JSON.stringify({
          result: 'pass',
          evidence: evidenceDirectory,
          tested: [
            'one-project-header',
            'project-list-filters-and-completed-fold',
            'attention-list-only',
            'four-column-filtered-board',
            'cross-project-deduplication',
            'human-and-cat-identity-chips',
            'single-project-breadcrumb-and-four-views',
            'dependency-ordered-plan-table',
            'project-context-and-activity',
            'non-overlapping-cross-project-dependency-detail',
            'exact-topic-source-return',
            'mobile-detail-and-plan-containment',
          ],
        }),
      );
    } finally {
      await context.close();
      await browser.close();
      await server.close();
      await rm(dataDirectory, { recursive: true });
    }
  },
);
