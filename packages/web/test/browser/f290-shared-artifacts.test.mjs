import '../../../api/test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import { collectiveArtifactOwnerFixture } from '../../../api/test/collective-artifact-owner.fixture.ts';
import { checkSharedArtifactAnnotationPages } from './helpers/shared-artifact-annotation-pages-journey.mjs';
import { cancelSharedRequestAfterProposalRace } from './helpers/shared-artifact-control-race-journey.mjs';
import { checkSharedArtifactLibrary } from './helpers/shared-artifact-library-journey.mjs';
import { sendSharedRequestAfterLostReply } from './helpers/shared-artifact-request-replay-journey.mjs';
import { checkSharedArtifactReview } from './helpers/shared-artifact-review-journey.mjs';

test(
  'normal Client publishes Markdown to its real owner and an independent member reads it beside the original Topic',
  { timeout: 90000 },
  async (t) => {
    // Use installed browser binaries, while all browser profiles and application data stay in the test sandbox.
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.CAT_CAFE_TEST_REAL_HOME && process.platform === 'darwin')
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.env.CAT_CAFE_TEST_REAL_HOME,
        'Library',
        'Caches',
        'ms-playwright',
      );
    const { chromium } = await import('../../../ppt-forge/node_modules/playwright/index.mjs');
    const f = await collectiveArtifactOwnerFixture(t, {
      verifyAgent: async (agent) => agent.catId === 'codex-sol' && agent.sessionRef === 'browser-agent-invocation',
    });
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: 'real-local-owner',
        defaultIngressThreadId: 'private-channel',
        humanNotificationThreadId: 'private-channel',
        agentRoutes: {
          [`${f.owner.human.humanId}:codex-sol`]: {
            catId: 'codex-sol',
            threadId: 'private-channel',
            participation: { displayName: 'Sol', channelIds: ['general'] },
          },
        },
      },
      1,
    );
    await f.connector.publishParticipation(f.connection.connectionId);
    const proposedWork = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
      ...f.coordinates,
      sourceEventId: f.source.eventId,
      requestId: 'shared-guide-original-work',
    });
    const originalWork = await f.store.commitCollectiveWork(f.owner.sessionToken, {
      ...f.coordinates,
      workId: proposedWork.workId,
      expectedRevision: proposedWork.revision,
      requestId: 'shared-guide-human-responsibility',
    });
    const browser = await chromium.launch({ headless: true });
    const shots = process.env.F290_SCREENSHOTS;
    if (shots) await mkdir(shots, { recursive: true });
    const capture = async (page, name) => {
      if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
    };
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 1440, height: 960 } }),
      browser.newContext({ viewport: { width: 1440, height: 960 } }),
    ]);
    let syncing = false;
    const timer = setInterval(async () => {
      if (syncing) return;
      syncing = true;
      try {
        await f.connector.sync(f.connection.connectionId);
      } finally {
        syncing = false;
      }
    }, 80);
    const pageErrors = [];
    try {
      const pages = [];
      for (const [index, auth] of [f.owner, f.member].entries()) {
        await contexts[index].addInitScript(
          ({ origin, token }) => {
            if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
          },
          { origin: f.server.url, token: auth.sessionToken },
        );
        const page = await contexts[index].newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(`${f.server.url}/?collectiveId=${f.coordinates.collectiveId}&channelId=general`, {
          waitUntil: 'networkidle',
        });
        pages.push(page);
      }
      const [owner, member] = pages;
      const text = '# 共同协作指南\n\n两名独立认证成员阅读同一份正文。\n\n## 原讨论\n版本和来源一起保留。\n';
      await owner.locator('.message').first().hover();
      await owner.locator('.message-action-more').first().click();
      await owner.getByRole('menuitem', { name: '分享作品…' }).click();
      await owner
        .getByLabel('Markdown 文件')
        .setInputFiles({ name: '共同协作指南.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
      await owner.getByLabel('作品存放在').selectOption({ label: 'Canonical content Café' });
      await owner.getByLabel('属于任务').selectOption(originalWork.workId);
      const ownerResponse = owner.waitForResponse(
        (response) =>
          response.url().endsWith('/api/artifacts/owner/request') &&
          response.status() === 200 &&
          response.request().postDataJSON().action === 'read',
      );
      void ownerResponse.catch(() => undefined);
      await owner.getByRole('button', { name: '分享作品', exact: true }).click();
      await owner.getByRole('heading', { name: '共同协作指南', exact: true }).waitFor();
      await member.getByRole('button', { name: '频道作品', exact: true }).click();
      const memberResponse = member.waitForResponse(
        (response) =>
          response.url().endsWith('/api/artifacts/owner/request') &&
          response.status() === 200 &&
          response.request().postDataJSON().action === 'read',
      );
      void memberResponse.catch(() => undefined);
      await member
        .getByRole('complementary', { name: '频道作品', exact: true })
        .locator('.shared-artifact-card')
        .filter({ hasText: '共同协作指南' })
        .click();
      await member.getByRole('heading', { name: '共同协作指南', exact: true }).waitFor();
      const ownerRead = (await (await ownerResponse).json()).value;
      const memberRead = (await (await memberResponse).json()).value;
      assert.equal(ownerRead.blobDigest, `sha256:${createHash('sha256').update(text).digest('hex')}`);
      assert.equal(memberRead.blobDigest, ownerRead.blobDigest);
      assert.equal(memberRead.ownerRevision, ownerRead.ownerRevision);
      assert.equal(memberRead.contentRef, ownerRead.contentRef);
      assert.equal(memberRead.text, text);
      assert.equal(
        await member
          .locator('.context-panel .topic-message .message-body')
          .getByText(f.source.body, { exact: true })
          .count(),
        1,
      );
      await member.setViewportSize({ width: 390, height: 844 });
      assert.equal(await member.evaluate(() => document.documentElement.scrollWidth), 390);
      await member.getByRole('button', { name: '讨论', exact: true }).click();
      const draft = member.locator('.context-panel textarea');
      await draft.fill('这是我还没发出的反馈。');
      await member.getByRole('button', { name: '关闭话题', exact: true }).click();
      await member.getByRole('button', { name: '讨论', exact: true }).click();
      assert.equal(await draft.inputValue(), '这是我还没发出的反馈。');
      await member.getByRole('button', { name: '关闭话题', exact: true }).click();
      await member.setViewportSize({ width: 1440, height: 960 });
      await member.getByRole('button', { name: '回到原讨论', exact: true }).click();
      await member.waitForFunction(
        (id) => document.getElementById(`collective-event-${id}`)?.dataset.highlighted === 'true',
        f.source.eventId,
      );
      assert.equal(await member.evaluate(() => document.activeElement?.id), `collective-event-${f.source.eventId}`);
      await member.locator('details.collective-menu > summary').click();
      await member.getByRole('button', { name: '打开Participation首页', exact: true }).click();
      await member
        .locator('[data-testid="collective-home"] .shared-artifact-card')
        .filter({ hasText: '共同协作指南' })
        .click();
      await member.getByRole('heading', { name: '共同协作指南', exact: true }).waitFor();
      assert.equal(
        await member
          .locator('.context-panel .topic-message .message-body')
          .getByText(f.source.body, { exact: true })
          .count(),
        1,
      );
      await member.locator('.shared-artifact-document').evaluate((paper) => {
        const text = '独立认证成员';
        const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent.indexOf(text);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const selected = window.getSelection();
          selected.removeAllRanges();
          selected.addRange(range);
          paper.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          return;
        }
        throw new Error('Expected real Markdown text');
      });
      await member.getByRole('group', { name: '作品引用', exact: true }).waitFor();
      const sourceComposer = member.locator('.context-panel textarea');
      await sourceComposer.fill('@Sol');
      await member.getByRole('option').filter({ hasText: 'Sol' }).click();
      await sourceComposer.fill('请把选中的这处写得更清楚。');
      await capture(member, 'select-and-ask');
      const feedback = await sendSharedRequestAfterLostReply(member, f);
      const events = await f.store.listEventsForHuman(f.member.sessionToken, f.coordinates.collectiveId);
      assert.equal(events.filter((event) => event.clientEventId === feedback.clientEventId).length, 1);
      assert.equal(feedback.location.rootEventId, f.source.eventId);
      assert.equal(feedback.recipient.agentId, 'codex-sol');
      const publishedWork = f.store
        .listArtifacts(f.owner.sessionToken, f.coordinates)
        .find((artifact) => artifact.title === '共同协作指南');
      assert.equal(publishedWork.workId, originalWork.workId);
      const agentSource = collectiveEventSourceIdentity(feedback);
      assert.ok(agentSource);
      const agent = {
        catId: 'codex-sol',
        agentId: 'codex-sol',
        displayName: 'Sol',
        sessionRef: 'browser-agent-invocation',
      };
      const target = {
        artifactId: publishedWork.artifactId,
        sourceEventId: publishedWork.sourceEventId,
        ownerRevision: 1,
      };
      const original = await f.connector.requestArtifactForAgent(agentSource, agent, {
        ...target,
        action: 'read',
        requestId: 'browser-agent-read',
        payload: {},
      });
      await f.connector.requestArtifactForAgent(agentSource, agent, {
        ...target,
        action: 'propose',
        requestId: 'browser-agent-proposal',
        payload: {
          kind: 'respond-modification',
          requestId: original.modification.requestId,
          operationId: '00000000-0000-4000-8000-000000000011',
          expectedOwnerRevision: 1,
          expectedProposalRevision: 0,
          baseRevision: original.blobDigest,
          response: '把成员身份写得更清楚。',
          edits: [
            {
              start: text.indexOf('独立认证成员'),
              end: text.indexOf('独立认证成员') + '独立认证成员'.length,
              expectedText: '独立认证成员',
              replacement: '各自登录的成员',
            },
          ],
        },
      });
      const second = await f.store.publishArtifactRequest(f.member.sessionToken, {
        ...f.coordinates,
        artifactId: publishedWork.artifactId,
        sourceEventId: publishedWork.sourceEventId,
        ownerRevision: 1,
        annotationIds: original.modification.annotationIds,
        expectedReviewRevision: original.view.review.revision,
        clientEventId: 'browser-second-version-bound-request',
        body: '另一份修改，请保留原来的简洁写法。',
        recipient: feedback.recipient,
      });
      const secondSource = collectiveEventSourceIdentity(second.source);
      assert.ok(secondSource);
      const secondRead = await f.connector.requestArtifactForAgent(secondSource, agent, {
        ...target,
        action: 'read',
        requestId: 'browser-second-read',
        payload: {},
      });
      const secondProposal = await f.connector.requestArtifactForAgent(secondSource, agent, {
        ...target,
        action: 'propose',
        requestId: 'browser-second-proposal',
        payload: {
          kind: 'respond-modification',
          requestId: secondRead.modification.requestId,
          operationId: '00000000-0000-4000-8000-000000000012',
          expectedOwnerRevision: 1,
          expectedProposalRevision: 0,
          baseRevision: original.blobDigest,
          response: '另一份基于旧正文的候选。',
          edits: [
            {
              start: text.indexOf('独立认证成员'),
              end: text.indexOf('独立认证成员') + '独立认证成员'.length,
              expectedText: '独立认证成员',
              replacement: '分别认证的成员',
            },
          ],
        },
      });
      const firstCard = (page) =>
        page.locator('.shared-artifact-requests article').filter({ hasText: '请把选中的这处写得更清楚。' });
      await firstCard(owner).getByRole('button', { name: '查看对照', exact: true }).click();
      await owner
        .locator('.context-panel .topic-message')
        .getByText('请把选中的这处写得更清楚。', { exact: true })
        .waitFor();
      await owner.getByRole('region', { name: '修改前后对比', exact: true }).waitFor();
      await owner.getByText('把成员身份写得更清楚。', { exact: true }).waitFor();
      await firstCard(member).getByRole('button', { name: '查看对照', exact: true }).click();
      await member.getByText('采用由有权成员决定，你仍可参与讨论。', { exact: true }).waitFor();
      assert.equal(await member.getByRole('button', { name: '采用', exact: true }).count(), 0);
      await member.getByRole('button', { name: '返回作品', exact: true }).click();
      await capture(owner, 'compare');
      if (shots) {
        await owner.setViewportSize({ width: 390, height: 844 });
        await capture(owner, 'compare-mobile');
        await owner.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
          document.documentElement.dataset.consoleTheme = 'dark';
        });
        await capture(owner, 'compare-dark-mobile');
        await owner.evaluate(() => {
          delete document.documentElement.dataset.theme;
          delete document.documentElement.dataset.consoleTheme;
        });
        await owner.setViewportSize({ width: 1440, height: 960 });
      }
      await owner.getByRole('button', { name: '采用', exact: true }).click();
      await owner
        .getByRole('region', { name: '修改前后对比', exact: true })
        .getByText('已采用为第 2 版', { exact: true })
        .waitFor();
      await owner.locator('.context-panel [data-source-kind="content-owner-receipt"]').waitFor();
      await owner.getByText('把成员身份写得更清楚。', { exact: true }).waitFor();
      await capture(owner, 'adopted-receipt');
      // Content adoption must preserve the independent Work decision and execution.
      const retainedWork = f.store
        .listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId)
        .works.find((work) => work.workId === originalWork.workId);
      assert.equal(retainedWork.lifecycle, originalWork.lifecycle);
      assert.equal(retainedWork.resultEventId, undefined);
      await member
        .locator('.shared-artifact-document')
        .getByText('两名各自登录的成员阅读同一份正文。', { exact: true })
        .waitFor();
      assert.equal(
        f.store
          .listArtifacts(f.member.sessionToken, f.coordinates)
          .find((artifact) => artifact.artifactId === publishedWork.artifactId).versionCount,
        2,
      );
      await member
        .locator('.shared-artifact-requests article')
        .filter({ hasText: '另一份修改，请保留原来的简洁写法。' })
        .getByRole('button', { name: '查看对照', exact: true })
        .click();
      await member.getByText('这份修改基于第 1 版，现在已是第 2 版', { exact: true }).waitFor();
      assert.equal(await member.getByRole('button', { name: '采用', exact: true }).count(), 0);
      const beforeRework = (await f.store.listEventsForHuman(f.member.sessionToken, f.coordinates.collectiveId)).length;
      await member.getByRole('button', { name: '请Sol基于第 2 版重做…', exact: true }).click();
      await member.waitForFunction(
        () => document.querySelector('.context-panel textarea')?.value === '基于第 2 版重做这一处。',
      );
      await member.getByText('第 1 版的修改 · 基于第 2 版重做', { exact: true }).waitFor();
      assert.equal(
        (await f.store.listEventsForHuman(f.member.sessionToken, f.coordinates.collectiveId)).length,
        beforeRework,
      );
      await capture(member, 'stale-rework-composer');
      const reworkSent = member.waitForResponse(
        (response) => response.url().endsWith('/api/artifacts/requests/publish') && response.status() === 201,
      );
      await member.locator('.context-panel').getByRole('button', { name: '发送', exact: true }).click();
      const reworkEvent = (await (await reworkSent).json()).source;
      const reworkSource = collectiveEventSourceIdentity(reworkEvent);
      assert.ok(reworkSource);
      const reworkRead = await f.connector.requestArtifactForAgent(reworkSource, agent, {
        ...target,
        ownerRevision: 2,
        action: 'read',
        requestId: 'browser-rework-read',
        payload: {},
      });
      assert.equal(reworkRead.ownerRevision, 2);
      assert.deepEqual(reworkRead.modification.rework, {
        requestId: secondRead.modification.requestId,
        proposalRef: secondProposal.proposal.proposalRef,
      });
      await member.waitForFunction(() => document.querySelector('.context-panel textarea')?.value === '');
      const reworkCard = member
        .locator('.shared-artifact-requests article')
        .filter({ hasText: '基于第 2 版重做这一处。' });
      await cancelSharedRequestAfterProposalRace({
        page: member,
        card: reworkCard,
        advance: () =>
          f.connector.requestArtifactForAgent(reworkSource, agent, {
            ...target,
            ownerRevision: 2,
            action: 'propose',
            requestId: 'browser-proposal-races-cancel',
            payload: {
              kind: 'respond-modification',
              requestId: reworkRead.modification.requestId,
              operationId: '00000000-0000-4000-8000-000000000013',
              expectedOwnerRevision: 2,
              expectedProposalRevision: 0,
              baseRevision: reworkRead.blobDigest,
              response: '取消前刚返回的候选仍保留。',
              edits: [{ start: 0, end: 0, expectedText: '', replacement: '共同审阅说明\n\n' }],
            },
          }),
      });
      await reworkCard.getByText('Sol · 已取消', { exact: true }).waitFor();
      await owner.getByRole('button', { name: '返回作品', exact: true }).click();
      await owner
        .locator('.shared-artifact-requests article')
        .filter({ hasText: '另一份修改，请保留原来的简洁写法。' })
        .getByRole('button', { name: '查看对照', exact: true })
        .click();
      const [rejectResponse] = await Promise.all([
        owner.waitForResponse(
          (response) =>
            response.url().endsWith('/api/artifacts/owner/request') &&
            response.request().postDataJSON().action === 'reject',
        ),
        owner.getByRole('button', { name: '不采用', exact: true }).click(),
      ]);
      const rejectBody = await rejectResponse.json();
      assert.equal(rejectResponse.status(), 200, JSON.stringify(rejectBody));
      const rejected = rejectBody.value.request;
      assert.equal(rejected.resolution.kind, 'rejected');
      await owner.getByText('这份修改未采用。', { exact: true }).waitFor();
      await owner
        .locator('.shared-artifact-message-feedback')
        .getByText('Sol · 未采用 · 查看对照', { exact: true })
        .waitFor();
      await member
        .locator('.shared-artifact-message-feedback')
        .getByText('Sol · 已取消 · 查看对照', { exact: true })
        .waitFor();
      assert.equal(
        f.store
          .listArtifacts(f.owner.sessionToken, f.coordinates)
          .find((item) => item.artifactId === publishedWork.artifactId).versionCount,
        2,
      );
      await capture(owner, 'declined-candidate');
      await checkSharedArtifactLibrary({
        page: owner,
        artifact: f.store
          .listArtifacts(f.owner.sessionToken, f.coordinates)
          .find((item) => item.artifactId === publishedWork.artifactId),
        originalText: text,
        request: feedback,
        capture,
      });
      await checkSharedArtifactReview({ page: owner, capture });
      await checkSharedArtifactAnnotationPages({ page: owner, capture });
      await owner.getByRole('button', { name: '回到原讨论', exact: true }).click();
      const returnedWork = owner
        .locator(`.channel-flow #collective-event-${f.source.eventId}`)
        .getByRole('region', { name: `任务 · ${originalWork.title}`, exact: true });
      await returnedWork.getByRole('button', { name: '标记完成', exact: true }).waitFor();
      await owner.waitForFunction(
        (id) => document.getElementById(`collective-event-${id}`)?.dataset.highlighted === 'true',
        f.source.eventId,
      );
      await owner.getByRole('button', { name: /全部作品/ }).click();
      await owner
        .getByRole('region', { name: '全部作品', exact: true })
        .locator('.shared-artifact-card')
        .filter({ hasText: '共同协作指南' })
        .click();
      await member.locator('.shared-artifact-document').evaluate((paper) => {
        const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent.indexOf('各自登录');
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 4);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          paper.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          return;
        }
        throw new Error('Expected adopted Markdown');
      });
      await member.getByRole('group', { name: '作品引用', exact: true }).waitFor();
      await sourceComposer.fill('这是撤权前我自己写下、还没发出的话。');
      const memberAccess = f.store
        .listArtifacts(f.member.sessionToken, f.coordinates)
        .find((artifact) => artifact.artifactId === publishedWork.artifactId);
      assert.ok(memberAccess);
      await f.store.updateArtifactAccess(f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: publishedWork.artifactId,
        humanId: f.member.human.humanId,
        expectedAccessRevision: memberAccess.accessRevision,
        access: 'revoked',
        requestId: 'browser-revoke-open-work',
      });
      await member.getByRole('heading', { name: '你已无法查看这件作品', exact: true }).waitFor();
      assert.equal(await member.locator('.shared-artifact-document').count(), 0);
      assert.equal(await member.getByRole('group', { name: '作品引用', exact: true }).count(), 0);
      assert.equal(await sourceComposer.inputValue(), '这是撤权前我自己写下、还没发出的话。');
      await capture(member, 'resource-revoked-draft');
      assert.equal(
        await member.evaluate((key) => sessionStorage.getItem(key), `collective-session:${f.server.url}`),
        f.member.sessionToken,
      );
      await owner
        .locator('.shared-artifact-document')
        .getByText('两名各自登录的成员阅读同一份正文。', { exact: true })
        .waitFor();
      await f.store.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId });
      await member.getByRole('heading', { name: '你已无法访问这个共同体', exact: true }).waitFor();
      assert.equal(await member.locator('.message, .shared-artifact-document, .context-panel').count(), 0);
      assert.equal(
        await member.getByLabel('未发送的文字 1', { exact: true }).inputValue(),
        '这是撤权前我自己写下、还没发出的话。',
      );
      assert.equal(
        await member.evaluate((key) => sessionStorage.getItem(key), `collective-session:${f.server.url}`),
        f.member.sessionToken,
      );
      await member.getByRole('button', { name: '重新检查访问', exact: true }).click();
      await member.getByRole('heading', { name: '你已无法访问这个共同体', exact: true }).waitFor();
      await contexts[1].grantPermissions(['clipboard-read', 'clipboard-write'], { origin: f.server.url });
      await member.getByRole('button', { name: '复制文字', exact: true }).click();
      await member.getByText('已复制你的文字', { exact: true }).waitFor();
      assert.equal(await member.evaluate(() => navigator.clipboard.readText()), '这是撤权前我自己写下、还没发出的话。');
      await capture(member, 'membership-lost-desktop');
      await member.setViewportSize({ width: 390, height: 844 });
      await capture(member, 'membership-lost-draft');
      assert.equal(await member.evaluate(() => document.documentElement.scrollWidth), 390);
      await member.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
        document.documentElement.dataset.consoleTheme = 'dark';
      });
      await capture(member, 'membership-lost-dark');
      await member.reload({ waitUntil: 'networkidle' });
      await member.getByRole('heading', { name: '你已无法访问这个共同体', exact: true }).waitFor();
      assert.equal(
        await member.getByLabel('未发送的文字 1', { exact: true }).inputValue(),
        '这是撤权前我自己写下、还没发出的话。',
      );
      assert.equal(await member.locator('.message, .shared-artifact-document, .context-panel').count(), 0);
      await owner
        .locator('.shared-artifact-document')
        .getByText('两名各自登录的成员阅读同一份正文。', { exact: true })
        .waitFor();
      assert.deepEqual(pageErrors, []);
    } catch (error) {
      console.error(error);
      for (const [index, context] of contexts.entries()) {
        for (const page of context.pages()) await capture(page, `shared-failure-${index}`);
      }
      throw error;
    } finally {
      clearInterval(timer);
      await browser.close();
    }
  },
);
