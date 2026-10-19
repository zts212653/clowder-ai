import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { seedAnotherHumanTodo, seedHumanSelfExecutedTask } from './f290-project-authoring.fixture.mjs';

const projectTitle = '项目页真实创建与责任确认';
const projectPurpose = '从项目页建立任务，并由受邀成员本人接下责任。';
const taskTitle = '让跨成员责任请求走完真实入口';
const taskOutcome = '任务、来源、邀请与接受都保持同一份可恢复记录。';
const staleOriginTitle = '旧邀请原项目';
const staleCurrentTitle = '共享任务当前项目';
const staleTaskTitle = '原项目已移出的责任邀请';
const ownerTodoTitle = '等待 You 指派的另一项目任务';

export function registerProjectAuthoringJourney() {
  test(
    'Project page atomically creates sources and keeps cross-Human responsibility pending until acceptance',
    {
      timeout: 60_000,
    },
    async () => {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-project-authoring-data-'));
      const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'f290-project-authoring-evidence-'));
      const opened = await CollectiveServiceStore.open({
        dataDirectory,
        humanAuthProvider: defaultHumanAuthProvider(),
      });
      const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
      const memberPairing = await opened.store.createPairingIntent({
        sessionToken: seeded.member.sessionToken,
        collectiveId: seeded.coordinates.collectiveId,
        hostOrigin: 'http://localhost:5183',
        nonce: 'project-authoring-member-cafe',
      });
      const memberConnection = await opened.store.exchangePairingIntent({
        ...memberPairing,
        endpointLabel: '吴浪的 Café',
      });
      await opened.store.publishParticipation(memberConnection.endpointCredential, {
        ...seeded.coordinates,
        connectionId: memberConnection.connectionId,
        revision: 1,
        agents: [
          { catId: 'codex-sol', displayName: '缅因猫', channelIds: ['产品方向'] },
          { catId: 'fable-5', displayName: '宪宪', channelIds: ['产品方向'] },
        ],
      });
      const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
      const browser = await chromium.launch({ headless: true });
      const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const memberContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installSession(ownerContext, server.url, seeded.owner.sessionToken);
      await installSession(memberContext, server.url, seeded.member.sessionToken);
      const ownerPage = await ownerContext.newPage();
      const memberPage = await memberContext.newPage();
      const ownerErrors = [];
      const memberErrors = [];
      ownerPage.on('pageerror', (error) => ownerErrors.push(error.message));
      memberPage.on('pageerror', (error) => memberErrors.push(error.message));
      try {
        await openProjectPage(ownerPage, server.url);
        const projectList = ownerPage.getByRole('region', { name: '项目列表', exact: true });
        await projectList.waitFor();
        assert.equal(await projectList.locator('[data-project-id]').count(), 0);
        await projectList.getByText('还没有项目。用右上角“新建项目”留下第一项目标与完成标准。').waitFor();

        await ownerPage.getByRole('button', { name: '新建项目', exact: true }).click();
        await ownerPage.getByLabel('项目名称', { exact: true }).fill(projectTitle);
        await ownerPage.getByLabel('项目完成标准', { exact: true }).fill(projectPurpose);
        assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await ownerPage.screenshot({
          path: path.join(evidenceDirectory, 'project-create-form-1440.png'),
          fullPage: true,
        });
        const projectCreated = ownerPage.waitForResponse(
          (response) =>
            response.url().endsWith('/api/collaboration/projects/create') && response.request().method() === 'POST',
        );
        await ownerPage.getByRole('button', { name: '创建项目', exact: true }).click();
        assert.equal((await projectCreated).status(), 201);
        await projectList.getByRole('button', { name: new RegExp(projectTitle) }).waitFor();

        await projectList.getByRole('button', { name: new RegExp(projectTitle) }).click();
        await ownerPage.getByRole('heading', { name: projectTitle, exact: true }).waitFor();
        await ownerPage.getByRole('button', { name: '新建任务', exact: true }).click();
        await ownerPage.getByLabel('任务名称', { exact: true }).fill(taskTitle);
        await ownerPage.getByLabel('任务完成标准', { exact: true }).fill(taskOutcome);
        await ownerPage.getByLabel('任务负责人', { exact: true }).selectOption({ label: '邀请 吴浪 负责' });
        await ownerPage.getByText('任务先保持待指派；对方接受邀请后才会成为负责人。', { exact: true }).waitFor();
        await ownerPage.screenshot({
          path: path.join(evidenceDirectory, 'task-create-request-form-1440.png'),
          fullPage: true,
        });
        const taskCreated = ownerPage.waitForResponse(
          (response) =>
            response.url().endsWith('/api/collaboration/projects/tasks/create') &&
            response.request().method() === 'POST',
        );
        await ownerPage.getByRole('button', { name: '创建任务', exact: true }).click();
        assert.equal((await taskCreated).status(), 201);
        await ownerPage.getByRole('button', { name: new RegExp(taskTitle) }).click();
        const ownerInspector = ownerPage.getByRole('complementary', { name: `任务详情 · ${taskTitle}`, exact: true });
        await ownerInspector.getByText('已邀请 吴浪，等待回复。', { exact: true }).waitFor();
        await ownerInspector.getByText('未分配', { exact: true }).first().waitFor();

        const beforeAcceptance = opened.store.listCollectiveCollaboration(
          seeded.owner.sessionToken,
          seeded.coordinates.collectiveId,
        );
        const createdProject = beforeAcceptance.roadmaps.find((roadmap) => roadmap.title === projectTitle);
        const createdWork = beforeAcceptance.works.find((work) => work.title === taskTitle);
        assert.ok(createdProject);
        assert.ok(createdWork);
        assert.deepEqual(createdProject.workIds, [createdWork.workId]);
        assert.equal(createdWork.accountableHumanId, undefined);
        assert.equal(createdWork.status, 'unassigned');
        assert.equal(createdWork.accountabilityRequests?.[0]?.status, 'pending');

        const staleOrigin = await opened.store.createCollectiveProject(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'stale-request-origin-project',
          channelId: '产品方向',
          title: staleOriginTitle,
          purpose: '邀请只在原项目仍持有任务时有效。',
        });
        const staleCreated = await opened.store.createCollectiveProjectTask(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'stale-request-task',
          roadmapId: staleOrigin.roadmapId,
          expectedRoadmapRevision: staleOrigin.revision,
          channelId: '产品方向',
          title: staleTaskTitle,
          intendedOutcome: '共享任务不能借另一个项目接受已经失效的邀请。',
          accountability: 'unassigned',
          requestedAccountableHumanId: seeded.member.human.humanId,
        });
        const staleCurrent = await opened.store.createCollectiveProject(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'stale-request-current-project',
          channelId: '产品方向',
          title: staleCurrentTitle,
          purpose: '保留共享任务，但不继承另一个项目的责任邀请。',
        });
        const staleCurrentWithWork = await opened.store.setCollectiveRoadmapWorks(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'stale-request-share-work',
          roadmapId: staleCurrent.roadmapId,
          expectedRevision: staleCurrent.revision,
          workIds: [staleCreated.work.workId],
        });
        const staleOriginWithoutWork = await opened.store.setCollectiveRoadmapWorks(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'stale-request-remove-origin',
          roadmapId: staleCreated.roadmap.roadmapId,
          expectedRevision: staleCreated.roadmap.revision,
          workIds: [],
        });
        await seedAnotherHumanTodo(opened.store, seeded, ownerTodoTitle);

        await openProjectPage(memberPage, server.url);
        const memberTodo = memberPage.getByRole('region', { name: '项目待办', exact: true });
        await memberTodo.getByText(taskTitle, { exact: true }).waitFor();
        assert.equal(await memberTodo.getByText(staleTaskTitle, { exact: true }).count(), 0);
        const allTodos = memberTodo.getByRole('button', { name: '全部待办', exact: true });
        assert.equal(await allTodos.getAttribute('aria-pressed'), 'false');
        await allTodos.click();
        assert.equal(await allTodos.getAttribute('aria-pressed'), 'true');
        await memberTodo.getByText(ownerTodoTitle, { exact: true }).waitFor();
        await allTodos.click();
        await memberTodo.getByText(ownerTodoTitle, { exact: true }).waitFor({ state: 'detached' });

        const memberProjectList = memberPage.getByRole('region', { name: '项目列表', exact: true });
        await memberProjectList.getByRole('button', { name: new RegExp(staleCurrentTitle) }).click();
        const stalePlan = memberPage.getByRole('region', { name: '项目任务计划', exact: true });
        const stalePlanRow = stalePlan.locator(`[data-project-plan-work-id="${staleCreated.work.workId}"]`);
        await stalePlanRow.waitFor();
        assert.equal(await stalePlanRow.getByRole('button', { name: '接受', exact: true }).count(), 0);
        assert.equal(await stalePlanRow.getByRole('button', { name: '暂不接受', exact: true }).count(), 0);
        await stalePlanRow.locator('.project-plan-task').click();
        const staleInspector = memberPage.getByRole('complementary', {
          name: `任务详情 · ${staleTaskTitle}`,
          exact: true,
        });
        await staleInspector.waitFor();
        assert.equal(await staleInspector.getByRole('button', { name: '接受负责', exact: true }).count(), 0);
        assert.equal(await staleInspector.getByRole('button', { name: '暂不接受', exact: true }).count(), 0);
        await memberPage.screenshot({
          path: path.join(evidenceDirectory, 'stale-project-invitation-retired-1440.png'),
          fullPage: true,
        });
        await staleInspector.getByRole('button', { name: '关闭任务详情', exact: true }).click();
        await memberPage
          .getByRole('navigation', { name: '项目观察方式' })
          .getByRole('button', { name: '看板', exact: true })
          .click();
        const staleCard = memberPage.locator(`[data-roadmap-work-id="${staleCreated.work.workId}"]`);
        await staleCard.waitFor();
        assert.equal(await staleCard.getByRole('group', { name: '卡内指定负责人', exact: true }).count(), 0);
        await memberPage.getByRole('navigation', { name: '项目层级' }).getByRole('button', { name: '项目' }).click();
        await memberTodo.getByText(taskTitle, { exact: true }).waitFor();
        await memberPage.screenshot({
          path: path.join(evidenceDirectory, 'same-project-todo-1440.png'),
          fullPage: true,
        });
        await memberTodo.getByRole('button', { name: '处理邀请', exact: true }).click();
        const memberInspector = memberPage.getByRole('complementary', { name: `任务详情 · ${taskTitle}`, exact: true });
        await memberInspector.getByText('You 邀请你负责', { exact: true }).waitFor();
        assert.deepEqual(
          await memberInspector.getByLabel('接下任务后', { exact: true }).locator('option').allTextContents(),
          ['我自己推进', '交给 缅因猫', '交给 宪宪'],
        );
        await memberInspector.getByLabel('接下任务后', { exact: true }).selectOption({ label: '交给 宪宪' });
        const accepted = memberPage.waitForResponse(
          (response) =>
            response.url().endsWith('/api/collaboration/work/accountability/respond') &&
            response.request().method() === 'POST',
        );
        await memberInspector.getByRole('button', { name: '接受负责', exact: true }).click();
        const acceptedResponse = await accepted;
        assert.equal(acceptedResponse.status(), 200);
        assert.deepEqual(acceptedResponse.request().postDataJSON().assignment, {
          connectionId: memberConnection.connectionId,
          catId: 'fable-5',
          participationRevision: 1,
        });
        await memberPage
          .getByRole('complementary', { name: `任务详情 · ${taskTitle}`, exact: true })
          .getByText('吴浪 负责', { exact: true })
          .waitFor();

        await memberPage.setViewportSize({ width: 390, height: 844 });
        assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const inspectorBox = await memberInspector.boundingBox();
        assert.ok(inspectorBox && inspectorBox.x >= 0 && inspectorBox.x + inspectorBox.width <= 390);
        await memberPage.screenshot({
          path: path.join(evidenceDirectory, 'accepted-responsibility-mobile-390.png'),
          fullPage: true,
        });
        await memberPage.getByRole('navigation', { name: '项目层级' }).getByRole('button', { name: '项目' }).click();
        await memberTodo.getByText(taskTitle, { exact: true }).waitFor({ state: 'detached' });

        await seedHumanSelfExecutedTask(opened.store, seeded, createdProject);
        const mixedExecutorRow = memberProjectList.locator(`[data-project-id="${createdProject.roadmapId}"]`);
        await mixedExecutorRow.locator('[data-identity-kind="human"]', { hasText: '吴浪执行' }).waitFor();
        assert.ok(await mixedExecutorRow.locator('[data-identity-kind="agent"]').count());

        const projection = opened.store.listCollectiveCollaboration(
          seeded.member.sessionToken,
          seeded.coordinates.collectiveId,
        );
        const acceptedWork = projection.works.find((work) => work.workId === createdWork.workId);
        assert.equal(projection.roadmaps.filter((roadmap) => roadmap.roadmapId === createdProject.roadmapId).length, 1);
        assert.equal(projection.works.filter((work) => work.workId === createdWork.workId).length, 1);
        assert.equal(acceptedWork?.accountableHumanId, seeded.member.human.humanId);
        assert.equal(acceptedWork?.assignment?.connectionId, memberConnection.connectionId);
        assert.equal(acceptedWork?.assignment?.catId, 'fable-5');
        assert.equal(acceptedWork?.accountabilityRequests?.[0]?.status, 'accepted');
        assert.equal(acceptedWork?.history.at(-1)?.action, 'accountability_request_accepted');
        const staleWork = projection.works.find((work) => work.workId === staleCreated.work.workId);
        assert.equal(staleWork?.accountabilityRequests?.[0]?.status, 'pending');
        assert.deepEqual(
          projection.roadmaps.find((roadmap) => roadmap.roadmapId === staleOriginWithoutWork.roadmapId)?.workIds,
          [],
        );
        assert.deepEqual(
          projection.roadmaps.find((roadmap) => roadmap.roadmapId === staleCurrentWithWork.roadmapId)?.workIds,
          [staleCreated.work.workId],
        );
        const events = await opened.store.listEventsForHuman(
          seeded.member.sessionToken,
          seeded.coordinates.collectiveId,
        );
        assert.equal(events.filter((event) => event.eventId === createdProject.sourceEventId).length, 1);
        assert.equal(events.filter((event) => event.eventId === createdWork.sourceEventId).length, 1);
        assert.equal(
          events.find((event) => event.eventId === createdWork.sourceEventId)?.location?.channelId,
          '产品方向',
        );
        assert.deepEqual(ownerErrors, []);
        assert.deepEqual(memberErrors, []);
        console.log(
          JSON.stringify({
            result: 'pass',
            evidence: evidenceDirectory,
            tested: [
              'empty-project-entry',
              'atomic-project-source',
              'atomic-task-source-and-membership',
              'pending-cross-human-request',
              'same-project-todo-item',
              'all-project-todos-toggle',
              'stale-cross-project-request-retired-on-detail-plan-and-board',
              'named-human-browser-acceptance',
              'human-and-cat-project-list-executors',
              'handled-project-todo-retirement',
              'single-project-and-task-after-refresh',
              'mobile-accountability-detail',
            ],
          }),
        );
      } finally {
        await ownerContext.close();
        await memberContext.close();
        await browser.close();
        await server.close();
        await rm(dataDirectory, { recursive: true });
      }
    },
  );
}

async function installSession(context, origin, sessionToken) {
  await context.addInitScript(
    ({ expectedOrigin, token }) => {
      if (location.origin === expectedOrigin) sessionStorage.setItem(`collective-session:${expectedOrigin}`, token);
    },
    { expectedOrigin: origin, token: sessionToken },
  );
}

async function openProjectPage(page, serviceUrl) {
  await page.goto(serviceUrl, { waitUntil: 'networkidle' });
  await page
    .getByRole('navigation', { name: '频道', exact: true })
    .getByRole('button', { name: /产品方向/ })
    .click();
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await page.locator('.project-workspace-heading').getByRole('heading', { name: '项目', exact: true }).waitFor();
}
