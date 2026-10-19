import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

const projectTitle = '跨成员上线确认';
const projectPurpose = '受邀成员从家里同一份待办回到项目任务，再由本人作出责任决定。';
const taskTitle = '核对 Host 待办与项目责任';
const taskOutcome = '待办只指向原项目任务；处理后 Service 与 Host 重新读取一致。';

export function registerAccountabilityMailboxJourney() {
  test(
    'a named Human opens the real Host mailbox item at the exact Project Task and retires it by declining there',
    { timeout: 120_000 },
    async () => {
      const ports = await reserveNativeOwnerPorts();
      const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-accountability-mailbox-service-'));
      const evidence = await mkdtemp(path.join(tmpdir(), 'f290-accountability-mailbox-evidence-'));
      const opened = await CollectiveServiceStore.open({
        dataDirectory,
        humanAuthProvider: defaultHumanAuthProvider(),
      });
      const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
      const server = await startCollectiveServer({
        store: opened.store,
        host: '127.0.0.1',
        port: 0,
        allowedHostOrigins: [`http://localhost:${ports.hostPort}`],
      });
      let browser;
      let nativeOwner;
      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        await context.addInitScript(
          ({ origin, token }) => {
            if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
          },
          { origin: server.url, token: seeded.member.sessionToken },
        );
        await context.addInitScript(() => {
          localStorage.setItem('cat-cafe:shell-presentation', 'v2');
          localStorage.setItem('cat-cafe:shell-language', 'zh');
        });
        nativeOwner = await startNativeOwner({
          store: opened.store,
          owner: seeded.member,
          collectiveId: seeded.coordinates.collectiveId,
          serviceUrl: server.url,
          context,
          ports,
        });
        const notificationThread = nativeOwner.threads.create(nativeOwner.userId, 'Collective responsibility owner');
        await nativeOwner.connector.setHostRoute(
          nativeOwner.connection.connectionId,
          {
            localOwnerUserId: nativeOwner.userId,
            defaultIngressThreadId: notificationThread.id,
            humanNotificationThreadId: notificationThread.id,
            agentRoutes: {},
          },
          0,
        );

        const project = await opened.store.createCollectiveProject(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'mailbox-project-create',
          channelId: '产品方向',
          title: projectTitle,
          purpose: projectPurpose,
        });
        const created = await opened.store.createCollectiveProjectTask(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          requestId: 'mailbox-project-task-create',
          roadmapId: project.roadmapId,
          expectedRoadmapRevision: project.revision,
          channelId: '产品方向',
          title: taskTitle,
          intendedOutcome: taskOutcome,
          accountability: 'unassigned',
          requestedAccountableHumanId: seeded.member.human.humanId,
        });
        const request = created.work.accountabilityRequests?.[0];
        assert.ok(request);
        assert.equal(request.status, 'pending');

        const host = await context.newPage();
        const pageErrors = [];
        host.on('pageerror', (error) => pageErrors.push(error.message));
        await host.goto(`${nativeOwner.hostUrl}/?shell=v2`, { waitUntil: 'domcontentloaded' });
        const directRead = await host.evaluate(async (apiUrl) => {
          try {
            const response = await fetch(
              `${apiUrl}/api/concierge/work/decisions?view=unified&includeUserMentions=true&offset=0&limit=20&personalView=visible`,
              { credentials: 'include' },
            );
            return { status: response.status, body: await response.json() };
          } catch (error) {
            return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
          }
        }, nativeOwner.apiUrl);
        assert.equal(directRead.status, 200, JSON.stringify(directRead.body));
        const firstBody = directRead.body;
        assert.equal(firstBody.sources.collectiveAccountabilityRequests.status, 'available');
        assert.equal(firstBody.sources.collectiveAccountabilityRequests.exhaustiveness, 'complete');
        assert.equal(firstBody.items.length, 1);
        assert.equal(
          firstBody.items[0].collectiveAccountabilityRequest.accountabilityRequestId,
          request.accountabilityRequestId,
        );
        await host.getByTestId('mailbox-button').click();
        const mailbox = host.getByTestId('mailbox-panel');
        await mailbox.waitFor();
        const row = mailbox.getByTestId('mailbox-item').filter({ hasText: taskTitle });
        await row.waitFor();
        assert.equal(await row.getAttribute('data-kind-label'), '责任邀请');
        await row.getByTestId('mailbox-item-toggle').click();
        await row.getByTestId('mailbox-accountability-project').getByText(projectTitle, { exact: true }).waitFor();
        await row.getByTestId('mailbox-accountability-requester').getByText('You', { exact: true }).waitFor();
        await host.screenshot({ path: path.join(evidence, 'host-mailbox-request-1440.png'), fullPage: true });

        await row.getByTestId('mailbox-open-original').click();
        await host.waitForURL((url) => {
          const current = new URL(url);
          return (
            current.pathname === '/collective' &&
            current.searchParams.get('target') === 'accountability' &&
            current.searchParams.get('connectionId') === nativeOwner.connection.connectionId &&
            current.searchParams.get('workId') === created.work.workId &&
            current.searchParams.get('workRevision') === String(created.work.revision) &&
            current.searchParams.get('roadmapId') === project.roadmapId &&
            current.searchParams.get('accountabilityRequestId') === request.accountabilityRequestId
          );
        });
        const embedded = host.frameLocator('iframe[title="Collective"]');
        await embedded.getByRole('heading', { name: projectTitle, exact: true }).waitFor();
        const inspector = embedded.getByRole('complementary', { name: `任务详情 · ${taskTitle}`, exact: true });
        await inspector.getByText('You 邀请你负责', { exact: true }).waitFor();
        await host.screenshot({ path: path.join(evidence, 'exact-project-task-1440.png'), fullPage: true });

        const reread = host.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/concierge/work/decisions' &&
            response.request().method() === 'GET' &&
            response.status() === 200,
        );
        const declined = host.waitForResponse(
          (response) =>
            response.url().endsWith('/api/collaboration/work/accountability/respond') &&
            response.request().method() === 'POST',
        );
        await inspector.getByRole('button', { name: '暂不接受', exact: true }).click();
        assert.equal((await declined).status(), 200);
        const refreshedBody = await (await reread).json();
        assert.deepEqual(refreshedBody.items, []);

        await host.setViewportSize({ width: 390, height: 844 });
        await host.goBack({ waitUntil: 'domcontentloaded' });
        if (!(await host.getByTestId('mailbox-panel').isVisible())) await host.getByTestId('mailbox-button').click();
        await mailbox.waitFor();
        await row.waitFor({ state: 'detached' });
        const emptyState = mailbox.getByText('本页没有等你决定的事', { exact: true });
        await emptyState.waitFor();
        assert.equal(await host.locator('[data-shell-sidebar="v2"]').count(), 0);
        await host.waitForFunction(() => document.querySelector('[data-testid="mailbox-panel"]')?.style.left === '0px');
        await mailbox.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        await emptyState.waitFor();
        const mailboxBox = await mailbox.boundingBox();
        assert.ok(
          mailboxBox && Math.abs(mailboxBox.x) < 0.5 && Math.abs(mailboxBox.width - 390) < 0.5,
          JSON.stringify(mailboxBox),
        );
        assert.equal(
          await emptyState.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            return Boolean(hit && (hit === element || element.contains(hit)));
          }),
          true,
          'the retired mailbox state must remain topmost and readable at 390px',
        );
        assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await host.screenshot({ path: path.join(evidence, 'retired-mailbox-390.png'), fullPage: true });

        const projection = opened.store.listCollectiveCollaboration(
          seeded.member.sessionToken,
          seeded.coordinates.collectiveId,
        );
        const currentWork = projection.works.find((work) => work.workId === created.work.workId);
        const currentRequest = currentWork?.accountabilityRequests?.find(
          (candidate) => candidate.accountabilityRequestId === request.accountabilityRequestId,
        );
        assert.equal(currentRequest?.status, 'declined');
        assert.equal(currentWork?.accountableHumanId, undefined);
        assert.equal(currentWork?.assignment, undefined);
        assert.deepEqual(pageErrors, []);
        console.log(
          JSON.stringify({
            result: 'pass',
            evidence,
            tested: [
              'service-authorized-host-mailbox-source',
              'stable-accountability-request-identity',
              'exact-project-task-navigation',
              'canonical-project-decline',
              'bridge-triggered-unified-reread',
              'resolved-item-retirement',
              'desktop-and-mobile-host-shell',
            ],
            data: 'isolated two-Human Service plus real Connector/API/Host; no model execution or production data',
          }),
        );
      } catch (error) {
        console.error(JSON.stringify({ evidence, result: 'fail' }));
        for (const [index, page] of (browser?.contexts().flatMap((current) => current.pages()) ?? []).entries()) {
          await page
            .screenshot({ path: path.join(evidence, `failure-${index}.png`), fullPage: true })
            .catch(() => undefined);
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
}
