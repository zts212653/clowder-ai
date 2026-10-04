import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

registerDefaultEntryJourney(
  {
    journeyId: 'f290-owner-work-policy',
    surfaceTestId: 'collective-work-policy-settings',
    title: 'members management and original proposal use Human registration and owner adoption',
    timeout: 12e4,
  },
  async (journey) => {
    const ports = await reserveNativeOwnerPorts();
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(path.join(tmpdir(), 'f290-ui-policy-'));
    const evidence = await mkdtemp(path.join(tmpdir(), 'f290-work-policy-ui-evidence-'));
    const opened = await CollectiveServiceStore.open({
      dataDirectory: directory,
      humanAuthProvider: defaultHumanAuthProvider(),
    });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const service = await startCollectiveServer({
      store: opened.store,
      host: '127.0.0.1',
      port: 0,
      allowedHostOrigins: [`http://localhost:${ports.hostPort}`],
    });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    let owner;
    let page;
    const calls = [];
    const transmitted = [];
    try {
      await mkdir(evidence, { recursive: true });
      await context.addInitScript(
        ({ origin, token }) => {
          if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        },
        { origin: service.url, token: seeded.owner.sessionToken },
      );
      owner = await startNativeOwner({
        store: opened.store,
        owner: seeded.owner,
        collectiveId: seeded.coordinates.collectiveId,
        serviceUrl: service.url,
        context,
        ports,
      });
      const actualOwner = owner;
      await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === service.url || url.origin === actualOwner.apiUrl) return route.continue();
        await route.abort();
        throw new Error(`Refused unrelated API origin ${url.origin}`);
      });
      page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).origin === actualOwner.apiUrl)
          calls.push({ path: new URL(request.url()).pathname, body: request.postData() });
      });
      await page.exposeFunction('collectBridgeEvidence', (message) => transmitted.push(message));
      await page.addInitScript(() => {
        window.addEventListener('message', (event) => {
          if (event.data?.type?.includes('work-policy')) void window.collectBridgeEvidence(event.data);
        });
      });
      await journey.enter(page, `${owner.hostUrl}/collective`, { waitUntil: 'networkidle' });
      const client = page.frameLocator('iframe[title="Collective"]');
      await client
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await client.getByRole('button', { name: '我的 Caf\xE9', exact: true }).waitFor();
      await client
        .getByRole('navigation', { name: '共同家园成员', exact: true })
        .getByRole('button', { name: /成员/ })
        .click();
      await client.getByRole('button', { name: '管理参与…', exact: true }).click();
      const panel = page.getByRole('complementary', { name: '我的 Caf\xE9', exact: true });
      await panel.getByRole('heading', { name: '授权规则', exact: true }).waitFor();
      await journey.arrive(page);
      await panel.getByRole('radio', { name: '值班猫把所有消息看一眼', exact: true }).click();
      await poll(
        async () =>
          (await actualOwner.connector.getHostRoute(actualOwner.connection.connectionId))?.channelListening?.[
            '产品方向'
          ]?.mode === 'all',
      );
      await panel.getByRole('radio', { name: '每件都要我批准', exact: true }).click();
      await poll(
        async () =>
          (await actualOwner.connector.readWorkPolicyStatus(actualOwner.connection.connectionId)).localAdoption
            ?.decisionMode === 'manual',
      );
      await page.screenshot({ path: path.join(evidence, 'settings-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: '关闭我的 Caf\xE9', exact: true }).click();
      const body = `UI_SENTINEL_${randomUUID()} \xB7 请写新人接入指南。`;
      await owner.receiveRequest(body);
      const source = (await owner.connector.listInbox(owner.connection.connectionId)).find(
        (item) => item.event.body === body,
      );
      assert.ok(source?.routeReceipt?.kind === 'thread_message');
      const sourceMessage = await owner.messages.getById(source.routeReceipt.messageId);
      assert.ok(sourceMessage?.source?.meta?.participation);
      const proposal = await owner.connector.proposeWork(
        sourceMessage.source.meta.participation,
        randomUUID(),
        {
          agentId: owner.cat.id,
          catId: owner.cat.id,
          displayName: owner.cat.displayName,
          sessionRef: 'scripted-browser-proposal',
        },
        { title: body, intendedOutcome: body, requestKind: 'guide' },
      );
      await client.getByRole('button', { name: '授权决定…', exact: true }).waitFor();
      await client.getByRole('button', { name: '授权决定…', exact: true }).click();
      const decision = page.getByRole('dialog', { name: '授权决定', exact: true });
      const registrationIds = [];
      let loseAfterCommit = true;
      await context.route('**/api/participation/work-policy/register', async (route) => {
        registrationIds.push(route.request().postDataJSON().requestId);
        if (!loseAfterCommit) return route.continue();
        loseAfterCommit = false;
        const registered = await route.fetch();
        assert.ok(registered.ok());
        const policy = await actualOwner.connector.readWorkPolicy(actualOwner.connection.connectionId);
        assert.ok(policy);
        const originalRule = policy.grants.find((rule) => rule.sourceEventIds?.includes(source.event.eventId));
        assert.ok(originalRule);
        await opened.store.registerCollectiveWorkPolicy(seeded.owner.sessionToken, {
          ...seeded.coordinates,
          connectionId: actualOwner.connection.connectionId,
          expectedRevision: policy.revision,
          requestId: `fixture-owner-revokes:${randomUUID()}`,
          decisionMode: policy.decisionMode,
          grants: policy.grants
            .filter((rule) => rule.status === 'active' && rule.grantRef !== originalRule.grantRef)
            .map(({ status: _status, grantRevision: _revision, ...scope }) => scope),
        });
        await route.abort('failed'); // actual commit, explicit owner withdrawal, then lost response
      });
      await decision.getByRole('button', { name: '允许这一次', exact: true }).click();
      await decision.getByRole('button', { name: '重新授权这一次', exact: true }).waitFor();
      await decision.getByRole('button', { name: '允许这一次', exact: true }).click();
      await poll(async () => registrationIds.length === 2);
      await decision.getByRole('button', { name: '重新授权这一次', exact: true }).waitFor();
      assert.equal(registrationIds[0], registrationIds[1], 'retry retains the old revoked operation');
      assert.equal(
        calls.some((call) => call.path.endsWith('/work/reconsider')),
        false,
      );
      assert.equal((await owner.tasks.listByKind('work')).length, 0);
      await page.screenshot({ path: path.join(evidence, 'revoked-old-decision.png'), fullPage: true });
      await decision.getByRole('button', { name: '重新授权这一次', exact: true }).click();
      await decision
        .getByText('规则已生效，猫将重新判断原请求', {
          exact: true,
        })
        .waitFor();
      assert.notEqual(registrationIds[0], registrationIds[2], 'fresh explicit Human choice has a new command');
      const once = (await owner.connector.readWorkPolicy(owner.connection.connectionId))?.grants.find(
        (rule2) => rule2.status === 'active' && rule2.sourceEventIds?.includes(source.event.eventId),
      );
      assert.ok(once);
      assert.deepEqual(once.catIds, [owner.cat.id]);
      assert.equal(
        (await owner.tasks.listByKind('work')).length,
        0,
        'rule/adoption/UNKNOWN wake does not manufacture Work acceptance',
      );
      const wakes = (await owner.queuedForChannel('产品方向')).filter(
        (entry) => entry.executionScope === 'collective-participation',
      );
      assert.ok(wakes.length > 0);
      await page.screenshot({ path: path.join(evidence, 'once-registered-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.ok((await decision.boundingBox()).width <= 390);
      await page.screenshot({ path: path.join(evidence, 'once-mobile.png'), fullPage: true });
      await decision.getByRole('button', { name: '以后这类都允许…', exact: true }).click();
      await decision.getByRole('button', { name: '允许此类工作', exact: true }).click();
      await poll(
        async () =>
          (await actualOwner.connector.readWorkPolicy(actualOwner.connection.connectionId))?.grants.some(
            (rule2) => !rule2.sourceEventIds && rule2.decisionMode === 'automatic',
          ) === true,
      );
      const afterClass = await owner.connector.readWorkPolicy(owner.connection.connectionId);
      assert.equal(afterClass?.decisionMode, 'manual');
      const rule = afterClass?.grants.find((grant) => !grant.sourceEventIds && grant.decisionMode === 'automatic');
      assert.deepEqual(rule?.catIds, [owner.cat.id]);
      assert.deepEqual(rule?.channelIds, ['产品方向']);
      assert.deepEqual(rule?.requestKinds, ['guide']);
      await decision
        .getByText('规则已生效，猫将重新判断原请求', {
          exact: true,
        })
        .waitFor();
      await decision.getByRole('button', { name: '不允许', exact: true }).click();
      await decision.getByText('已拒绝这项提议', { exact: true }).waitFor();
      const projection = opened.store.listCollectiveCollaboration(
        seeded.owner.sessionToken,
        seeded.coordinates.collectiveId,
      );
      assert.equal(projection.works.find((work) => work.workId === proposal.workId)?.lifecycle, 'declined');
      assert.equal((await owner.tasks.listByKind('work')).length, 0);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: path.join(evidence, 'declined-mobile-dark.png'), fullPage: true });
      assert.equal(
        calls.some((call) => call.path.endsWith('/work/admit')),
        false,
      );
      assert.ok(transmitted.length);
      assert.equal(JSON.stringify(transmitted).includes(seeded.owner.sessionToken), false);
      await writeFile(
        path.join(evidence, 'browser-dom.json'),
        JSON.stringify(
          {
            fixture: 'Human auth/model are fixtures; real Next/Service/Connector/Host components',
            hostUrl: owner.hostUrl,
            serviceUrl: service.url,
            buildChunks: await page
              .locator('script[src*="chunks/app/collective"]')
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src'))),
            calls,
            bridge: transmitted,
            registrationIds,
            decisionText: await decision.innerText(),
            errors,
          },
          null,
          2,
        ),
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
      await writeFile(
        path.join(evidence, 'failure.json'),
        JSON.stringify({ calls, dom: await page?.content(), error: String(error) }, null, 2),
      );
      throw error;
    } finally {
      await browser.close();
      await owner?.close();
      await service.close();
      await ports.close();
      await rm(directory, { recursive: true });
    }
  },
);
async function poll(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Actual state did not change');
}
