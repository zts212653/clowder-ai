import assert from 'node:assert/strict';
import path from 'node:path';
import { openChannelFromCollectiveHome } from './f290-channel-entry.harness.mjs';
import { disableMockHostPwa } from './f290-mock-host-context.harness.mjs';
import { startNext, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';

/** Actual Next owner controls over explicit Host DTO fixtures; the embedded Client uses the real test Service. */
export async function verifyFirstCatOwnerControls({
  browser,
  hostPort,
  serviceUrl,
  coordinates,
  owner,
  connections,
  evidence,
}) {
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  const next = startNext(hostPort);
  let page;
  try {
    await waitForHttp(`${hostUrl}/collective`, next);
    // Host reload must keep Playwright API fixtures in control of each request.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    await disableMockHostPwa(page.context(), hostUrl);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ token, origin }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      },
      { token: owner.sessionToken, origin: serviceUrl },
    );
    const projected = connections.map((connection) => ({
      ...coordinates,
      serviceUrl,
      authorizedHumanId: connection.authorizedHumanId,
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
      endpointLabel: 'Same Café label with a long but valid endpoint name',
      authorityStatus: 'connected',
      liveStatus: 'online',
      lastAckedSequence: 0,
      outbox: { queued: 0, accepted: 0 },
      route: { configured: true },
      inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
    }));
    const view = {
      revision: 1,
      published: false,
      reconcileRequired: true,
      cats: [
        { id: 'codex-astra', displayName: 'Astra', configured: true, eligible: true, supported: true },
        {
          id: 'unsupported',
          displayName: 'Other provider',
          configured: true,
          eligible: false,
          supported: false,
        },
      ],
      desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
      observedEligibility: {
        'codex-astra': { displayName: 'Astra', configured: true, eligible: true },
        unsupported: { displayName: 'Other provider', configured: true, eligible: false },
      },
      channelRoutes: {},
      standingInterests: {},
      attentionRevision: 0,
      bindings: {},
      threads: [],
      requests: [],
      tasks: [],
    };
    const mutations = [];
    let entryMode = false;
    let entryPair;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === serviceUrl) return route.continue();
      let status = url.pathname === '/api/session' ? 200 : 404;
      let body = {};
      if (url.pathname === '/api/plugins/collective-connector') {
        body = entryMode
          ? {
              runtimeStatus: 'active',
              connections: entryPair ? [{ ...projected[0], connectionId: 'con_entry_preview' }] : [],
              localService: { state: 'ready', serviceUrl },
            }
          : { runtimeStatus: 'active', connections: projected };
        status = 200;
      }
      if (url.pathname === '/api/plugins/collective-connector/entry-roster') {
        body = {
          fingerprint: 'a'.repeat(64),
          cats: [
            {
              id: 'codex-astra',
              displayName: '小星星·砚砚',
              eligible: true,
              avatar: '/avatars/codex.png',
              roleDescription: '一起看清协作方向',
              defaultModel: 'gpt-6-astra',
            },
            { id: 'unsupported', displayName: '尚未可参与的猫', eligible: false },
          ],
        };
        status = 200;
      }
      if (url.pathname === '/api/plugins/collective-connector/pair' && request.method() === 'POST') {
        entryPair = request.postDataJSON();
        body = { connectionId: 'con_entry_preview' };
        status = 200;
      }
      if (url.pathname.endsWith('/participation/reconcile') && request.method() === 'POST') {
        const input = request.postDataJSON();
        mutations.push({ path: url.pathname, body: input });
        view.revision += 1;
        view.published = true;
        view.reconcileRequired = false;
        view.channelRoutes = Object.fromEntries(
          input.channelIds.map((channelId) => [
            channelId,
            {
              channelId,
              threadId: `public-${channelId}`,
              participants: { 'codex-astra': { displayName: 'Astra' } },
            },
          ]),
        );
        body = { revision: view.revision, published: true };
        status = 200;
      } else if (url.pathname.endsWith('/participation')) {
        status = 200;
        body = view;
      } else if (url.pathname.endsWith('/work-policy')) {
        status = 200;
        body = { policy: null, localAdoption: null };
      } else if (url.pathname.endsWith('/listening')) {
        status = 200;
        body = { attentionRevision: 0, channelListening: {} };
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`${hostUrl}/collective`, { waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: '带猫加入', exact: true }).count(), 0);
    await page
      .getByRole('button')
      .filter({ hasText: connections[1].endpointId.slice(-6) })
      .click();
    const frame = page.frameLocator('iframe[title="Collective"]');
    await openChannelFromCollectiveHome(frame, 'general');
    await frame.getByRole('button', { name: '查看成员', exact: true }).click();
    const cafe = page.getByRole('region', { name: '我的猫 · 仅自己可见', exact: true });
    await page.getByText('家里的可参与伙伴已自动接入。', { exact: true }).waitFor();
    const astra = cafe.getByRole('switch', { name: 'Astra（@codex-astra）参与这个共同体', exact: true });
    const unsupported = cafe.getByRole('switch', {
      name: 'Other provider（@unsupported）参与这个共同体',
      exact: true,
    });
    assert.equal(await astra.getAttribute('aria-checked'), 'true', await astra.evaluate((option) => option.outerHTML));
    assert.equal(
      await unsupported.getAttribute('aria-checked'),
      'false',
      await unsupported.evaluate((option) => option.outerHTML),
    );
    assert.equal(await unsupported.isDisabled(), true, await unsupported.evaluate((option) => option.outerHTML));
    assert.equal(mutations.length, 1);
    assert.equal(
      mutations[0].path,
      `/api/plugins/collective-connector/${connections[1].connectionId}/participation/reconcile`,
    );
    assert.equal(mutations[0].body.standingWork, undefined, 'automatic participation does not grant private execution');
    assert.equal(mutations[0].body.catId, undefined, 'automatic participation reconciles policy, not one chosen cat');
    assert.equal(mutations[0].body.expectedRevision, 1);
    assert.deepEqual([...mutations[0].body.channelIds].sort(), ['general', 'workshop']);
    await page.screenshot({ path: path.join(evidence, 'owner-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(evidence, 'owner-mobile.png'), fullPage: true });
    for (const control of [astra, unsupported]) {
      const box = await control.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `owner control clipped: ${JSON.stringify(box)}`);
    }
    await frame.getByRole('button', { name: '关闭成员资料', exact: true }).click();
    await frame.getByRole('button', { name: '频道导航', exact: true }).click();
    await frame.locator('details.collective-menu > summary').click();
    await frame.getByRole('button', { name: '重新连接…', exact: true }).click();
    const connectionPicker = page.getByLabel('选择 Café 连接');
    const connectionBox = await connectionPicker.boundingBox();
    assert.ok(
      connectionBox && connectionBox.x >= 0 && connectionBox.x + connectionBox.width <= 390,
      `owner connection control clipped: ${JSON.stringify(connectionBox)}`,
    );

    entryMode = true;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(
      await page.evaluate(() => 'serviceWorker' in navigator),
      false,
      'Host API fixtures must remain controlled by Playwright after reload',
    );
    const entryFrame = page.frameLocator('iframe[title="Collective"]');
    await openChannelFromCollectiveHome(entryFrame, 'general');
    await entryFrame.getByRole('button', { name: '连接此 Café', exact: true }).click();
    const entry = page.getByRole('complementary', { name: '带入伙伴前确认' });
    await entry.getByText('小星星·砚砚').waitFor();
    assert.equal(entryPair, undefined, 'pairing cannot exchange a credential before roster confirmation');
    await page.screenshot({ path: path.join(evidence, 'owner-entry-desktop.png'), fullPage: true });
    const choice = entry.getByRole('checkbox', { name: '带入 小星星·砚砚' });
    assert.equal(await choice.isChecked(), true);
    await choice.uncheck();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(evidence, 'owner-entry-mobile.png'), fullPage: true });
    const confirm = entry.getByRole('button', { name: '确认带入 0 位伙伴' });
    const confirmBox = await confirm.boundingBox();
    assert.ok(confirmBox && confirmBox.x >= 0 && confirmBox.x + confirmBox.width <= 390);
    await confirm.click();
    await page.getByRole('complementary', { name: '带入伙伴前确认' }).waitFor({ state: 'hidden' });
    assert.deepEqual(entryPair.excludedCatIds, ['codex-astra']);
    assert.equal(entryPair.rosterFingerprint, 'a'.repeat(64));
    assert.deepEqual(errors, []);
  } finally {
    await page?.close();
    await stopChild(next);
  }
}
