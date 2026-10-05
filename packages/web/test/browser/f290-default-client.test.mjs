import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import {
  defaultHumanAuthProvider,
  openNativeOwnerClient,
  seedDefaultCollective,
  setupResponseRequest,
  verifyStandaloneClient,
} from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

test(
  'default Client restores the accepted channel layout and uses real Service messages and membership',
  { timeout: 90_000 },
  async () => {
    const ports = await reserveNativeOwnerPorts();
    const { hostPort } = ports;
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-default-service-'));
    const evidence = await mkdtemp(path.join(tmpdir(), 'f290-default-evidence-'));
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: defaultHumanAuthProvider(),
    });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const server = await startCollectiveServer({
      store: opened.store,
      host: '127.0.0.1',
      port: 0,
      allowedHostOrigins: [`http://localhost:${hostPort}`],
    });
    let browser;
    let nativeOwner;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await verifyStandaloneClient({ context, evidence, seeded, serviceUrl: server.url });
      nativeOwner = await startNativeOwner({
        store: opened.store,
        owner: seeded.owner,
        collectiveId: seeded.coordinates.collectiveId,
        serviceUrl: server.url,
        context,
        ports,
      });
      const { cafe, embedded, host, nativeErrors } = await openNativeOwnerClient({
        context,
        evidence,
        nativeOwner,
        seeded,
        serviceUrl: server.url,
      });
      const { composer, response, responseRequest } = await setupResponseRequest({ cafe, embedded, nativeOwner });

      const ordinaryTalk = '今天阳光不错。';
      await composer.fill(ordinaryTalk);
      await embedded.getByRole('button', { name: '发送', exact: true }).click();
      await embedded.getByText(ordinaryTalk, { exact: true }).waitFor();
      assert.equal((await nativeOwner.dispatchPending()).failed, 0);
      assert.equal((await nativeOwner.queuedForChannel('产品方向')).length, 1, 'ordinary talk must not add a wake');
      const ordinaryItem = (await nativeOwner.connector.listInbox(nativeOwner.connection.connectionId)).find(
        (item) => item.event.body === ordinaryTalk,
      );
      assert.equal(ordinaryItem.routeReceipt.attention, undefined);
      const unrelatedWorkRequest = '插件频道里另有一项先到的私人工作，只用来证明 assignment 不能按 Task 顺序猜。';
      assert.equal((await nativeOwner.receiveRequest(unrelatedWorkRequest, '插件共建')).failed, 0);
      const unrelatedWorkItem = (await nativeOwner.connector.listInbox(nativeOwner.connection.connectionId)).find(
        (item) => item.event.body === unrelatedWorkRequest,
      );
      assert.ok(unrelatedWorkItem);
      const unrelatedTask = await nativeOwner.admitPrivateWorkForEvent(
        unrelatedWorkItem.event.eventId,
        '这是一项更早创建、但不属于后续公开 Work assignment 的私人工作。',
      );

      const linkedWorkTalk = '把默认首页接到真实数据，并把结果带回这里。';
      await composer.fill(linkedWorkTalk);
      await embedded.getByRole('button', { name: '发送', exact: true }).click();
      await embedded.getByText(linkedWorkTalk, { exact: true }).waitFor();
      assert.equal((await nativeOwner.dispatchPending()).failed, 0);
      assert.equal((await nativeOwner.queuedForChannel('产品方向')).length, 1, 'uncommitted talk stays quiet');
      const linkedWorkArticle = embedded.locator('article.message').filter({ hasText: linkedWorkTalk });
      const appendPosition = await linkedWorkArticle.boundingBox();
      assert.ok(appendPosition, 'the newest message must remain at its natural append position');
      await linkedWorkArticle.hover();
      await linkedWorkArticle.getByRole('button', { name: '更多消息动作', exact: true }).click();
      const workAction = linkedWorkArticle.getByRole('menuitem', { name: '整理为工作', exact: true });
      const ball = host.getByTestId('concierge-ball-wrapper');
      const reserved = host.locator('[data-concierge-reserved-rect="collective-message-actions"]');
      await host.getByRole('button', { name: '猫猫球 — 待机中', exact: true }).waitFor();
      const [actionBox, ballBox, reservedBox] = await Promise.all([
        workAction.boundingBox(),
        ball.boundingBox(),
        reserved.boundingBox(),
      ]);
      assert.ok(
        actionBox && ballBox && reservedBox,
        'append-position action, Host reservation and default concierge ball must all be visible',
      );
      assert.equal(
        actionBox.x < reservedBox.x + reservedBox.width &&
          actionBox.x + actionBox.width > reservedBox.x &&
          actionBox.y < reservedBox.y + reservedBox.height &&
          actionBox.y + actionBox.height > reservedBox.y,
        true,
        'the Collective Host reservation must cover the real append-position action',
      );
      assert.equal(
        actionBox.x < ballBox.x + ballBox.width &&
          actionBox.x + actionBox.width > ballBox.x &&
          actionBox.y < ballBox.y + ballBox.height &&
          actionBox.y + actionBox.height > ballBox.y,
        false,
        'the default concierge ball must not cover the append-position message action',
      );
      await workAction.click();
      await linkedWorkArticle.getByText('工作提议 · 来自这条消息', { exact: true }).waitFor();
      await linkedWorkArticle.getByRole('button', { name: `交给 ${nativeOwner.cat.displayName}`, exact: true }).click();
      await linkedWorkArticle.getByText('可以开始', { exact: true }).waitFor();
      await linkedWorkArticle.scrollIntoViewIfNeeded();
      await host.screenshot({ path: path.join(evidence, 'default-linked-work-1440.png'), fullPage: true });
      await linkedWorkArticle.getByRole('button', { name: '建立路线', exact: true }).click();
      await embedded.getByRole('button', { name: 'Roadmap', exact: true }).waitFor();
      await embedded.getByRole('button', { name: 'Roadmap', exact: true }).click();
      await embedded.getByRole('heading', { name: '产品方向 路线', exact: true }).waitFor();
      await embedded.getByRole('button', { name: '依赖关系', exact: true }).click();
      await embedded.getByText('没有前置工作', { exact: true }).waitFor();
      await embedded.getByRole('button', { name: '对话', exact: true }).click();

      const linkedWorkEvent = (
        await opened.store.listEventsForHuman(seeded.owner.sessionToken, seeded.coordinates.collectiveId)
      ).find((event) => event.body === linkedWorkTalk && event.actor.kind === 'human');
      assert.ok(linkedWorkEvent);
      const publicWork = opened.store
        .listCollectiveCollaboration(seeded.owner.sessionToken, seeded.coordinates.collectiveId)
        .works.find((work) => work.sourceEventId === linkedWorkEvent.eventId);
      assert.ok(publicWork?.assignmentEventId);
      assert.equal((await nativeOwner.dispatchPending()).failed, 0);
      await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
      const publicWorkRequest = cafe.getByRole('article').filter({ hasText: linkedWorkTalk });
      assert.equal(await publicWorkRequest.getByRole('button', { name: '交给它持续处理', exact: true }).count(), 0);
      await nativeOwner.admitCommittedWorkForEvent(publicWork.assignmentEventId);
      await publicWorkRequest.getByRole('link', { name: '查看私人工作', exact: true }).waitFor();
      const admittedPublicTask = await nativeOwner.workTaskForEvent(publicWork.assignmentEventId);
      assert.notEqual(
        admittedPublicTask.id,
        unrelatedTask.id,
        'the public assignment must resolve its exact private Task instead of the first Work item',
      );
      assert.equal(admittedPublicTask.status, 'todo');
      await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
      const publicResult = '真实首页已接通，结果留在原讨论。';
      await nativeOwner.replyToEvent(publicWork.assignmentEventId, publicResult);
      await embedded.getByText(publicResult, { exact: true }).waitFor();
      await linkedWorkArticle.getByText('结果 v1 已回到原讨论，等负责人确认。', { exact: true }).waitFor();
      const revisionFeedback = '请补上重启后的恢复证据。';
      const revisionRequest = host.waitForResponse(
        (response) => response.url().endsWith('/work/result/revision') && response.request().method() === 'POST',
      );
      await linkedWorkArticle.getByLabel('修订反馈', { exact: true }).fill(revisionFeedback);
      await linkedWorkArticle.getByRole('button', { name: '退回修改', exact: true }).click();
      const revisionResponse = await revisionRequest;
      assert.equal(revisionResponse.status(), 200, await revisionResponse.text());
      assert.equal((await nativeOwner.dispatchPending()).failed, 0);
      await linkedWorkArticle.getByText(`已退回结果 v1 · ${revisionFeedback}`, { exact: true }).waitFor();
      assert.equal((await nativeOwner.tasks.get(admittedPublicTask.id)).entrustedWork.closure.state, 'open');

      const parallelWorkTalk = '并行核对同一频道的第二项工作，不要被前一项返修阻塞。';
      const parallelWork = await createCommittedPublicWork({
        body: parallelWorkTalk,
        cafe,
        catDisplayName: nativeOwner.cat.displayName,
        collectiveId: seeded.coordinates.collectiveId,
        embedded,
        host,
        nativeOwner,
        ownerSessionToken: seeded.owner.sessionToken,
        store: opened.store,
      });
      assert.notEqual(parallelWork.publicWork.workId, publicWork.workId);
      assert.notEqual(parallelWork.task.id, admittedPublicTask.id);
      assert.notEqual(parallelWork.task.threadId, admittedPublicTask.threadId);
      const parallelResult = '第二项工作已独立完成，未等待第一项返修。';
      await nativeOwner.replyToEvent(parallelWork.publicWork.assignmentEventId, parallelResult);
      await embedded.getByText(parallelResult, { exact: true }).waitFor();
      await parallelWork.article.getByText('结果 v1 已回到原讨论，等负责人确认。', { exact: true }).waitFor();
      const parallelClosure = host.waitForResponse(
        (response) => response.url().endsWith('/work/result/accepted') && response.request().method() === 'POST',
      );
      await parallelWork.article.getByRole('button', { name: '确认结果并完成', exact: true }).click();
      assert.equal((await parallelClosure).status(), 200);
      assert.equal((await nativeOwner.tasks.get(parallelWork.task.id)).status, 'done');
      assert.equal((await nativeOwner.tasks.get(admittedPublicTask.id)).status, 'todo');
      assert.equal((await nativeOwner.tasks.get(admittedPublicTask.id)).entrustedWork.closure.state, 'open');

      const revisedPublicResult = '真实首页已接通，并补齐重启后的恢复证据。';
      await nativeOwner.replyToEvent(publicWork.assignmentEventId, revisedPublicResult, 2);
      await embedded.getByText(revisedPublicResult, { exact: true }).waitFor();
      await linkedWorkArticle.getByText('结果 v2 已回到原讨论，等负责人确认。', { exact: true }).waitFor();
      const hostClosure = host.waitForResponse(
        (response) => response.url().endsWith('/work/result/accepted') && response.request().method() === 'POST',
      );
      await linkedWorkArticle.getByRole('button', { name: '确认结果并完成', exact: true }).click();
      const closureResponse = await hostClosure;
      assert.equal(closureResponse.status(), 200, await closureResponse.text());
      const closedPublicTask = await nativeOwner.tasks.get(admittedPublicTask.id);
      assert.equal(closedPublicTask.status, 'done');
      assert.equal(closedPublicTask.entrustedWork.closure.state, 'satisfied');
      const untouchedUnrelatedTask = await nativeOwner.tasks.get(unrelatedTask.id);
      assert.equal(untouchedUnrelatedTask.status, 'todo');
      assert.equal(untouchedUnrelatedTask.entrustedWork.closure.state, 'open');
      await linkedWorkArticle.getByText('已完成', { exact: true }).waitFor();
      await embedded.getByRole('button', { name: 'Roadmap', exact: true }).click();
      await embedded.getByText('已完成', { exact: true }).waitFor();
      await host.screenshot({ path: path.join(evidence, 'default-roadmap-1440.png'), fullPage: true });
      await embedded.getByRole('button', { name: '对话', exact: true }).click();

      const queuedBeforeResponse = (await nativeOwner.queuedForChannel('产品方向')).length;
      await nativeOwner.replyToRequest(responseRequest, response);
      await embedded.getByText(response, { exact: true }).waitFor();
      await embedded.getByText('希望伙伴回应 · 已有回应', { exact: true }).waitFor();
      assert.equal(
        (await nativeOwner.queuedForChannel('产品方向')).length,
        queuedBeforeResponse,
        'the returning Agent event must not self-awaken the endpoint',
      );
      await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
      await cafe.getByText('已有回应；回应已回到共同现场', { exact: true }).waitFor({ timeout: 7_000 });
      await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
      assert.equal((await nativeOwner.receiveRequest('请把这段讨论整理成可以一起审阅的首页方案。')).failed, 0);
      assert.equal((await nativeOwner.receiveRequest('再独立检查消息、话题与私人工作的边界。')).failed, 0);
      await nativeOwner.receiveRequest('插件频道的请求应当留在它自己的位置。', '插件共建');
      const requests = ['请把这段讨论整理成可以一起审阅的首页方案。', '再独立检查消息、话题与私人工作的边界。'];
      await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
      await cafe.getByText(requests[0], { exact: true }).waitFor();
      const admittedRequestTaskIds = [];
      for (const body of requests) {
        const article = cafe.getByRole('article').filter({ hasText: body });
        assert.equal(await article.getByRole('button', { name: '交给它持续处理', exact: true }).count(), 0);
        assert.equal(await article.getByRole('link', { name: '查看私人工作', exact: true }).count(), 0);
        const source = (await nativeOwner.connector.listInbox(nativeOwner.connection.connectionId)).find(
          (item) => item.event.body === body,
        );
        assert.ok(source);
        const taskCount = (await nativeOwner.tasks.listByKind('work')).length;
        await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
        const proposal = await nativeOwner.proposeWorkForEvent(source.event.eventId, body);
        const proposalArticle = embedded.locator('article.message').filter({ hasText: body });
        await proposalArticle.getByRole('button', { name: '授权决定…', exact: true }).click();
        const decision = host.getByRole('dialog', { name: '授权决定', exact: true });
        await decision.getByRole('button', { name: '允许这一次', exact: true }).click();
        await decision.getByText('规则已生效，猫将重新判断原请求', { exact: true }).waitFor();
        assert.equal(
          (await nativeOwner.tasks.listByKind('work')).length,
          taskCount,
          'permission is not Cat acceptance',
        );
        await decision.getByRole('button', { name: '关闭授权决定', exact: true }).click();
        const accepted = await nativeOwner.acceptAuthorizedRequest(source.event.eventId, body);
        assert.equal(accepted.work.workId, proposal.workId, 'acceptance continues the exact original proposal');
        assert.equal(accepted.work.assignment.catId, nativeOwner.cat.id);
        const current = await nativeOwner.connector.readAssignedWork(
          nativeOwner.connection.connectionId,
          accepted.work.workId,
        );
        assert.equal(
          current.acceptance.hostAdmission.state,
          'admitted',
          'Service records the actual Host Task receipt',
        );
        admittedRequestTaskIds.push(accepted.task.id);
        await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
        await article.getByRole('link', { name: '查看私人工作', exact: true }).waitFor();
      }
      const work = (await nativeOwner.tasks.listByKind('work')).filter((task) => task.id !== unrelatedTask.id);
      const expectedWorkTaskIds = [admittedPublicTask.id, parallelWork.task.id, ...admittedRequestTaskIds];
      assert.equal(
        new Set(expectedWorkTaskIds).size,
        2 + requests.length,
        'each distinct public source must admit its own private Work Task',
      );
      assert.deepEqual(new Set(work.map((task) => task.id)), new Set(expectedWorkTaskIds));
      assert.equal(
        new Set(work.map((task) => task.threadId)).size,
        work.length,
        'independent Work keeps its own private execution context',
      );
      assert.equal(await cafe.getByText('插件频道的请求应当留在它自己的位置。', { exact: true }).count(), 0);
      await host.screenshot({ path: path.join(evidence, 'default-embedded-cafe-1440.png'), fullPage: true });
      const frame = host.frames().find((candidate) => new URL(candidate.url() || 'about:blank').origin === server.url);
      assert.ok(frame);
      const publicText = await frame.locator('body').innerText();
      for (const task of work) {
        assert.equal(publicText.includes(task.threadId), false);
        assert.equal(await frame.locator(`a[href="/thread/${task.threadId}"]`).count(), 0);
      }
      await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
      await embedded
        .locator('article.message')
        .filter({ hasText: seeded.cat.body })
        .getByRole('button', { name: /2 条回复/ })
        .click();
      await embedded.getByRole('complementary', { name: '话题', exact: true }).waitFor();
      assert.equal(await cafe.count(), 0);
      await host.setViewportSize({ width: 390, height: 844 });
      await embedded.getByRole('button', { name: '关闭话题', exact: true }).click();
      await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
      await cafe.waitFor();
      assert.equal(await host.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await host.screenshot({ path: path.join(evidence, 'default-embedded-cafe-mobile.png'), fullPage: true });
      assert.deepEqual(nativeErrors, []);
      await host.close();
      await nativeOwner.close();
      nativeOwner = undefined;
      const prototype = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      prototype.setDefaultTimeout(15_000);
      prototype.setDefaultNavigationTimeout(15_000);
      await prototype.goto('http://127.0.0.1:5102/dev/collective-experience-gate', { waitUntil: 'domcontentloaded' });
      await prototype.getByRole('heading', { name: '# 产品方向', exact: true }).waitFor();
      await prototype.screenshot({ path: path.join(evidence, 'prototype-channel-1440.png'), fullPage: true });
      console.log(
        JSON.stringify({
          result: 'pass',
          evidence,
          entry: '/',
          tested: [
            'channel',
            'topic',
            'refresh',
            'member',
            'mobile',
            'dark',
            'native-owner-routes',
            'automatic-participation',
            'bounded-no-at-response',
            'ordinary-talk-no-wake',
            'append-position-pointer-action',
            'linked-public-work',
            'roadmap-result-return',
            'feedback-result-v2-adoption',
            'parallel-linked-public-work-isolation',
            'real-private-work',
            'owner-permission-not-acceptance',
            'scripted-natural-acceptance',
            'durable-host-admission',
            'iframe-boundary',
          ],
          data: 'production Service/Connector/Host components; Human login and Cat execution fixtures; not two-Human or real-model UAT',
        }),
      );
    } catch (error) {
      console.error(JSON.stringify({ evidence, result: 'fail' }));
      for (const [index, page] of (browser?.contexts().flatMap((context) => context.pages()) ?? []).entries()) {
        await page.screenshot({ path: path.join(evidence, `failure-${index}.png`) }).catch(() => undefined);
      }
      throw error;
    } finally {
      await nativeOwner?.close();
      await ports.close();
      await browser?.close();
      await server.close();
      await rm(dataDirectory, { recursive: true });
    }
  },
);

// Public commitment stays a real Human UI action; only the private execution
// adapter is fixture-driven, through the production authenticated admission route.
async function createCommittedPublicWork({
  body,
  cafe,
  catDisplayName,
  collectiveId,
  embedded,
  nativeOwner,
  ownerSessionToken,
  store,
}) {
  const composer = embedded.getByPlaceholder('在 #产品方向 里说点什么……');
  await composer.fill(body);
  await embedded.getByRole('button', { name: '发送', exact: true }).click();
  const article = embedded.locator('article.message').filter({ hasText: body });
  await article.getByText(body, { exact: true }).waitFor();
  assert.equal((await nativeOwner.dispatchPending()).failed, 0);
  await article.hover();
  await article.getByRole('button', { name: '更多消息动作', exact: true }).click();
  await article.getByRole('menuitem', { name: '整理为工作', exact: true }).click();
  await article.getByRole('button', { name: `交给 ${catDisplayName}`, exact: true }).click();
  await article.getByText('可以开始', { exact: true }).waitFor();
  const event = (await store.listEventsForHuman(ownerSessionToken, collectiveId)).find(
    (candidate) => candidate.body === body && candidate.actor.kind === 'human',
  );
  assert.ok(event);
  const publicWork = store
    .listCollectiveCollaboration(ownerSessionToken, collectiveId)
    .works.find((work) => work.sourceEventId === event.eventId);
  assert.ok(publicWork?.assignmentEventId);
  assert.equal((await nativeOwner.dispatchPending()).failed, 0);
  const task = await nativeOwner.admitCommittedWorkForEvent(publicWork.assignmentEventId);
  await embedded.getByRole('button', { name: '我的 Café', exact: true }).click();
  await cafe
    .getByRole('article')
    .filter({ hasText: body })
    .getByRole('link', { name: '查看私人工作', exact: true })
    .waitFor();
  await cafe.getByRole('button', { name: '关闭我的 Café', exact: true }).click();
  return { article, event, publicWork, task };
}
