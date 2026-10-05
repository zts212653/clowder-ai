import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

test(
  'a current prepared Artifact enters Needs Me and returns to the exact Collective result',
  { timeout: 120_000 },
  async () => {
    const ports = await reserveNativeOwnerPorts();
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-result-artifact-service-'));
    const evidence = await mkdtemp(path.join(tmpdir(), 'f290-result-artifact-evidence-'));
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
        { origin: server.url, token: seeded.owner.sessionToken },
      );
      nativeOwner = await startNativeOwner({
        store: opened.store,
        owner: seeded.owner,
        collectiveId: seeded.coordinates.collectiveId,
        serviceUrl: server.url,
        context,
        ports,
      });
      const privateThread = nativeOwner.threads.create(nativeOwner.userId, 'Collective result owner');
      await nativeOwner.threads.addParticipants(privateThread.id, [nativeOwner.cat.id]);
      const route = await nativeOwner.connector.setHostRoute(
        nativeOwner.connection.connectionId,
        {
          localOwnerUserId: nativeOwner.userId,
          defaultIngressThreadId: privateThread.id,
          humanNotificationThreadId: privateThread.id,
          agentRoutes: {
            [`${seeded.owner.human.humanId}:${nativeOwner.cat.id}`]: {
              catId: nativeOwner.cat.id,
              threadId: privateThread.id,
              participation: { displayName: nativeOwner.cat.displayName, channelIds: ['general'] },
            },
          },
        },
        0,
      );
      await nativeOwner.connector.publishParticipation(nativeOwner.connection.connectionId);
      const source = await opened.store.postHumanMessage(seeded.owner.sessionToken, {
        ...seeded.coordinates,
        clientEventId: 'result-artifact-source',
        location: { channelId: 'general' },
        recipient: { kind: 'channel' },
        body: '请把准备好的结果带回来，由我在原 Work 判断。',
      });
      const proposed = await opened.store.proposeCollectiveWork(seeded.owner.sessionToken, {
        ...seeded.coordinates,
        sourceEventId: source.eventId,
        requestId: 'result-artifact-proposal',
      });
      const committed = await opened.store.commitCollectiveWork(seeded.owner.sessionToken, {
        ...seeded.coordinates,
        workId: proposed.workId,
        expectedRevision: proposed.revision,
        requestId: 'result-artifact-commit',
        assignment: {
          connectionId: nativeOwner.connection.connectionId,
          catId: nativeOwner.cat.id,
          participationRevision: route.revision,
        },
      });
      assert.ok(committed.assignmentEventId);
      assert.equal((await nativeOwner.dispatchPending()).failed, 0);
      const task = await nativeOwner.admitPrivateWorkForEvent(
        committed.assignmentEventId,
        'Prepare one owner-backed result Artifact',
      );
      const preparedTask = await nativeOwner.attachArtifactToTask(task.id);
      assert.equal(preparedTask.entrustedWork.artifactRefs.length, 1);
      const resultBody = '结果产物已经准备好，请在这里确认。';
      await nativeOwner.replyToEvent(committed.assignmentEventId, resultBody);
      const resultReady = opened.store
        .listCollectiveCollaboration(seeded.owner.sessionToken, seeded.coordinates.collectiveId)
        .works.find((work) => work.workId === committed.workId);
      assert.equal(resultReady?.lifecycle, 'result_ready');
      assert.ok(resultReady?.resultEventId);

      const ownerReads = await nativeOwner.ownerReads.listNeedsMeForOwner(nativeOwner.userId);
      assert.equal(ownerReads.length, 1);
      const ownerRead = ownerReads[0];
      const receipt = ownerRead?.attentionReceipts.find((candidate) => candidate.eligible);
      assert.ok(ownerRead?.preparedArtifact && receipt?.eligible);
      assert.equal(receipt.producer.producerId, 'f290.collective_work_result');
      assert.equal(
        receipt.action.actionRef.includes(task.id),
        false,
        'public return must not disclose private Task identity',
      );

      const host = await context.newPage();
      const errors = [];
      host.on('pageerror', (error) => errors.push(error.message));
      await host.goto(nativeOwner.hostUrl, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(host);
      await host.getByTestId('workspace-launcher-needs-me').click();
      const needsMe = host.getByTestId('needs-me-panel');
      await needsMe.waitFor();
      const needsMeItems = needsMe.getByTestId('needs-me-item');
      await needsMeItems.first().waitFor();
      assert.equal(await needsMeItems.count(), 1);
      const needsMeItem = needsMeItems.first();
      const needsMeItemRef = await needsMeItem.getAttribute('data-item-ref');
      assert.ok(needsMeItemRef);
      assert.equal(await needsMeItem.getAttribute('data-task-subject-ref'), ownerRead.envelope.subjectRef);
      assert.equal(await needsMeItem.getAttribute('data-task-revision'), String(ownerRead.envelope.revision));
      assert.equal(await needsMeItem.getAttribute('data-producer-id'), 'f290.collective_work_result');
      assert.equal(await needsMeItem.getAttribute('data-producer-revision'), String(receipt.producer.revision));
      const artifactPreview = needsMeItem.getByTestId('prepared-artifact-preview');
      const artifactCoordinates = {
        artifactRef: await artifactPreview.getAttribute('data-artifact-ref'),
        completenessRef: await artifactPreview.getAttribute('data-completeness-ref'),
        previewRef: await artifactPreview.getAttribute('data-preview-ref'),
      };
      assert.deepEqual(artifactCoordinates, {
        artifactRef: ownerRead.preparedArtifact.artifactRef,
        completenessRef: ownerRead.preparedArtifact.completenessRef,
        previewRef: ownerRead.preparedArtifact.previewRef,
      });

      await needsMeItem.getByTestId('needs-me-open-artifact').click();
      const workbench = host.getByTestId('f307-experience-workbench');
      await host.waitForFunction(() =>
        document
          .querySelector('[data-testid="f307-experience-workbench"]')
          ?.getAttribute('data-active-surface')
          ?.startsWith('artifact:'),
      );
      await workbench.getByText('Prepared Collective result', { exact: true }).waitFor();
      await workbench.getByText('The owner-backed result is ready to review.', { exact: true }).waitFor();
      await workbench.getByRole('button', { name: '返回', exact: true }).click();
      await needsMe.waitFor();
      assert.equal(await needsMeItem.getAttribute('data-item-ref'), needsMeItemRef);
      assert.equal(await needsMeItem.getAttribute('data-selected'), 'true');

      const exactActionUrl = new URL(receipt.action.actionRef, nativeOwner.hostUrl).href;
      await needsMeItem.getByTestId('needs-me-open-action').click();
      await host.waitForURL(exactActionUrl);
      const embedded = host.frameLocator('iframe[title="Collective"]');
      const topic = embedded.getByRole('complementary', { name: '话题', exact: true });
      await topic.waitFor();
      assert.equal(
        await host
          .locator('iframe[title="Collective"]')
          .evaluate((frame) => frame.getBoundingClientRect().height >= window.innerHeight - 1),
        true,
        'the chromeless Collective action route must own the full viewport height',
      );
      const exactResult = topic.locator(`[data-event-id="${resultReady.resultEventId}"]`);
      await exactResult.getByText(resultBody, { exact: true }).waitFor();
      assert.equal(await exactResult.getAttribute('data-highlighted'), 'true');
      assert.equal(await exactResult.evaluate((element) => document.activeElement === element), true);
      await host.screenshot({ path: path.join(evidence, 'needs-me-exact-result-1440.png'), fullPage: true });
      await host.reload({ waitUntil: 'networkidle' });
      await topic.waitFor();
      await exactResult.getByText(resultBody, { exact: true }).waitFor();
      assert.equal(await exactResult.getAttribute('data-highlighted'), 'true');
      assert.equal(await exactResult.evaluate((element) => document.activeElement === element), true);
      await host.setViewportSize({ width: 390, height: 844 });
      assert.equal(await host.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await host.screenshot({ path: path.join(evidence, 'needs-me-exact-result-390.png'), fullPage: true });

      await host.goBack({ waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(host);
      await needsMe.waitFor();
      assert.equal(await needsMeItem.getAttribute('data-item-ref'), needsMeItemRef);
      assert.equal(await needsMeItem.getAttribute('data-selected'), 'true');
      assert.deepEqual(
        {
          artifactRef: await artifactPreview.getAttribute('data-artifact-ref'),
          completenessRef: await artifactPreview.getAttribute('data-completeness-ref'),
          previewRef: await artifactPreview.getAttribute('data-preview-ref'),
        },
        artifactCoordinates,
      );
      assert.equal(await needsMe.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
      await host.screenshot({ path: path.join(evidence, 'needs-me-return-390.png'), fullPage: true });

      await host.goForward({ waitUntil: 'domcontentloaded' });
      await host.waitForURL(exactActionUrl);
      await topic.waitFor();
      await exactResult.getByText(resultBody, { exact: true }).waitFor();
      assert.equal(await exactResult.getAttribute('data-highlighted'), 'true');

      const reconciled = host.waitForResponse(
        (response) => response.url().endsWith('/work/result/accepted') && response.request().method() === 'POST',
      );
      await topic.getByRole('button', { name: '确认结果并完成', exact: true }).click();
      const reconciliation = await reconciled;
      assert.equal(reconciliation.status(), 200, await reconciliation.text());
      assert.deepEqual(await nativeOwner.ownerReads.listNeedsMeForOwner(nativeOwner.userId), []);
      const closedTask = await nativeOwner.tasks.get(task.id);
      assert.equal(closedTask.status, 'done');
      assert.equal(closedTask.entrustedWork.closure.state, 'satisfied');

      await host.goBack({ waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(host);
      await needsMe.waitFor();
      await needsMe.getByRole('button', { name: '刷新', exact: true }).click();
      await needsMeItem.waitFor({ state: 'detached' });
      await needsMe.getByText('暂时没有要你判断的事', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: 'pass',
          evidence,
          tested: [
            'owner-derived-artifact-snapshot',
            'result-ready-needs-me',
            'public-only-action-ref',
            'workspace-needs-me-artifact-return',
            'exact-channel-topic-result-focus',
            'refresh-exact-return',
            'workspace-return-same-item',
            'desktop-mobile-return',
            'accepted-result-retirement',
          ],
          data: 'isolated Service/Host fixture; not two-Human UAT',
        }),
      );
    } catch (error) {
      console.error(JSON.stringify({ evidence, result: 'fail' }));
      for (const [index, page] of (browser?.contexts().flatMap((current) => current.pages()) ?? []).entries()) {
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
