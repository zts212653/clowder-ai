import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';

async function seedRoadmaps(store, seeded) {
  let sequence = 0;
  const post = (body, channelId = '产品方向', replyToEventId) =>
    store.postHumanMessage(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      clientEventId: `u3-roadmap-source-${++sequence}`,
      body,
      location: { channelId },
      recipient: { kind: 'channel' },
      ...(replyToEventId ? { replyToEventId } : {}),
    });
  const propose = (sourceEventId, label) =>
    store.proposeCollectiveWork(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: `u3-propose-${label}`,
      sourceEventId,
    });
  const commit = (proposal, label, assigned = false) =>
    store.commitCollectiveWork(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: `u3-commit-${label}`,
      workId: proposal.workId,
      expectedRevision: proposal.revision,
      ...(assigned
        ? {
            assignment: {
              connectionId: seeded.connection.connectionId,
              catId: 'codex-astra',
              participationRevision: 1,
            },
          }
        : {}),
    });

  const prerequisiteSource = await post('先把正式入口与恢复路径接稳。');
  const activeSource = await post('砚砚继续推进完整可用版本。');
  const pluginRoot = await post('插件频道需要一条移动端发布路径。', '插件共建');
  const mobileSource = await store.postHumanMessage(seeded.member.sessionToken, {
    ...seeded.coordinates,
    clientEventId: 'u3-roadmap-topic-source',
    target: { kind: 'message', eventId: pluginRoot.eventId },
    replyToEventId: pluginRoot.eventId,
    body: '移动端发布要等正式入口稳定后再开始。',
  });
  const completedSource = await post('安全 Markdown 已经合入并保留原始来源。');

  const prerequisite = await commit(await propose(prerequisiteSource.eventId, 'prerequisite'), 'prerequisite');
  const active = await commit(await propose(activeSource.eventId, 'active'), 'active', true);
  if (!active.assignmentEventId) throw new Error('Expected the active Work to have an assignment event');
  await store.postAgentMessage(seeded.connection.endpointCredential, {
    ...seeded.coordinates,
    connectionId: seeded.connection.connectionId,
    clientEventId: 'u3-active-result',
    agent: {
      agentId: 'codex-astra',
      catId: 'codex-astra',
      displayName: '小星星 · 砚砚',
      sessionRef: 'u3-roadmap-browser-fixture',
    },
    target: { kind: 'message', eventId: activeSource.eventId },
    location: { channelId: '产品方向', rootEventId: activeSource.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: active.assignmentEventId,
    workResultIntent: {
      assignmentEventId: active.assignmentEventId,
      participationRevision: 1,
      resultRevision: 1,
    },
    body: '完整可用版本的首轮实现已回到共同路线，等待负责人确认。',
  });
  const mobileCommitted = await commit(await propose(mobileSource.eventId, 'mobile'), 'mobile', true);
  const mobile = await store.setCollectiveWorkDependencies(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-mobile-dependency',
    workId: mobileCommitted.workId,
    expectedRevision: mobileCommitted.revision,
    dependencyWorkIds: [prerequisite.workId],
  });
  const completedCommitted = await commit(await propose(completedSource.eventId, 'completed'), 'completed');
  const completed = await store.completeCollectiveWork(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-complete-markdown',
    workId: completedCommitted.workId,
    expectedRevision: completedCommitted.revision,
  });

  const created = await store.createCollectiveRoadmap(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-create-primary-roadmap',
    sourceEventId: seeded.first.eventId,
    title: '完整可用版本',
    purpose: '让基础能力、体验修整和真实验收沿同一批 Work 继续。',
    workIds: [completed.workId],
  });
  const closed = await store.setCollectiveRoadmapStatus(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-close-primary-roadmap',
    roadmapId: created.roadmapId,
    expectedRevision: created.revision,
    status: 'completed',
    note: '首个可交付切片已验收。',
  });
  const reopened = await store.setCollectiveRoadmapStatus(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-reopen-primary-roadmap',
    roadmapId: closed.roadmapId,
    expectedRevision: closed.revision,
    status: 'active',
    note: '继续完整版本路线。',
  });
  const primary = await store.setCollectiveRoadmapWorks(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-expand-primary-roadmap',
    roadmapId: reopened.roadmapId,
    expectedRevision: reopened.revision,
    workIds: [completed.workId, prerequisite.workId, active.workId, mobile.workId],
  });

  const followupCreated = await store.createCollectiveRoadmap(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-create-followup-roadmap',
    sourceEventId: completedSource.eventId,
    title: '发布后跟进',
    purpose: '保留已完成工作的后续观察。',
    workIds: [completed.workId],
  });
  const followup = await store.setCollectiveRoadmapStatus(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-close-followup-roadmap',
    roadmapId: followupCreated.roadmapId,
    expectedRevision: followupCreated.revision,
    status: 'completed',
  });
  return { primary, followup, prerequisite, active, mobile, completed, mobileSource };
}

test(
  'Roadmap keeps one Work truth across lenses, projections, source navigation, and mobile return',
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
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await page
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
      await page.getByRole('heading', { name: records.primary.title, exact: true }).waitFor();
      assert.deepEqual(
        await page.getByRole('navigation', { name: 'Roadmap 观察方式' }).getByRole('button').allTextContents(),
        ['阶段路线', '依赖关系', '我的路线'],
      );
      assert.deepEqual(
        await page.getByRole('group', { name: 'Roadmap 呈现方式' }).getByRole('button').allTextContents(),
        ['工作图', '状态看板'],
      );
      assert.deepEqual(
        await page.getByRole('group', { name: 'Roadmap 显示范围' }).getByRole('button').allTextContents(),
        ['当前重点', '全部工作'],
      );

      const workIds = (locator) =>
        locator
          .locator('[data-roadmap-work-id]')
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.roadmapWorkId));
      const focusTree = page.getByRole('region', { name: 'Roadmap 工作图', exact: true });
      assert.deepEqual(
        new Set(await workIds(focusTree)),
        new Set([records.prerequisite.workId, records.active.workId, records.mobile.workId]),
      );
      await page.getByRole('button', { name: '全部工作', exact: true }).click();
      const allWorkIds = await workIds(focusTree);
      assert.equal(allWorkIds.length, 4);

      const visualSignatures = await focusTree.locator('[data-roadmap-work-id]').evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return `${node.dataset.statusTone}:${style.borderStyle}:${style.borderColor}:${style.backgroundColor}`;
        }),
      );
      assert.equal(new Set(visualSignatures).size, 4, 'four canonical status tones remain visually distinct');

      await page.getByRole('button', { name: '状态看板', exact: true }).click();
      const board = page.getByRole('region', { name: 'Roadmap 状态看板', exact: true });
      assert.deepEqual(new Set(await workIds(board)), new Set(allWorkIds));
      assert.equal(
        await page
          .getByRole('navigation', { name: 'Roadmap 观察方式' })
          .getByRole('button', { name: '阶段路线' })
          .getAttribute('aria-current'),
        'page',
      );

      await page.getByRole('button', { name: '依赖关系', exact: true }).click();
      const graph = page.getByRole('region', { name: '依赖工作图', exact: true });
      assert.equal((await workIds(graph)).length, 4);
      assert.equal(new Set(await workIds(graph)).size, 4, 'dependency projection renders each canonical Work once');
      assert.equal(await graph.locator('[data-dependency-level="0"]').count(), 3);
      assert.equal(await graph.locator('[data-dependency-level="1"]').count(), 1);

      await graph.getByRole('button', { name: new RegExp(records.mobile.title) }).click();
      const inspector = page.getByRole('complementary', { name: `工作详情 · ${records.mobile.title}`, exact: true });
      await inspector.getByText('You 负责', { exact: true }).waitFor();
      await inspector.getByText('小星星 · 砚砚 推进', { exact: true }).waitFor();
      await inspector.getByText('#插件共建 · 话题', { exact: true }).waitFor();
      await inspector.getByText('调整了前置工作', { exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: '依赖工作图', exact: true }).count(), 1);
      await page.screenshot({ path: path.join(evidenceDirectory, 'u3-roadmap-desktop-1440.png'), fullPage: true });

      await inspector.getByRole('button', { name: '查看来源消息', exact: true }).click();
      await page.getByRole('heading', { name: '# 插件共建', exact: true }).waitFor();
      await page
        .locator(`[data-event-id="${records.mobileSource.eventId}"]`)
        .locator('.topic-message .message-body')
        .getByText(records.mobileSource.body, { exact: true })
        .waitFor();
      const returnButton = page.getByRole('button', { name: `← 返回 ${records.primary.title}`, exact: true });
      await returnButton.click();
      await page.getByRole('heading', { name: records.primary.title, exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('navigation', { name: 'Roadmap 观察方式' })
          .getByRole('button', { name: '依赖关系' })
          .getAttribute('aria-current'),
        'page',
      );
      await page.getByRole('complementary', { name: `工作详情 · ${records.mobile.title}`, exact: true }).waitFor();

      await page.locator('summary[aria-label="打开 Roadmap 操作历史"]').click();
      await page.getByText('重新打开了路线', { exact: true }).waitFor();
      assert.equal(await page.getByText('今天已冻结', { exact: true }).count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileInspector = page.getByRole('complementary', {
        name: `工作详情 · ${records.mobile.title}`,
        exact: true,
      });
      const inspectorBox = await mobileInspector.boundingBox();
      assert.ok(inspectorBox && inspectorBox.x >= 0 && inspectorBox.x + inspectorBox.width <= 390);
      assert.ok(
        await page.locator('.roadmap-canvas').isVisible(),
        'the Roadmap remains present behind the mobile sheet',
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: path.join(evidenceDirectory, 'u3-roadmap-mobile-390.png'), fullPage: true });

      const projection = opened.store.listCollectiveCollaboration(
        seeded.owner.sessionToken,
        seeded.coordinates.collectiveId,
      );
      assert.equal(projection.roadmaps.length, 2);
      assert.equal(
        projection.roadmaps.find((item) => item.roadmapId === records.primary.roadmapId)?.history.at(-2)?.action,
        'reopened',
      );
      console.log(
        JSON.stringify({
          result: 'pass',
          evidence: evidenceDirectory,
          tested: [
            'stable-lenses',
            'orthogonal-projection-scope',
            'unique-parallel-dependency-graph',
            'status-grammar',
            'work-inspector-history',
            'exact-topic-source-return',
            'mobile-sheet-continuity',
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
