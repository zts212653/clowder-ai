import assert from 'node:assert/strict';
import path from 'node:path';
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
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(
      ({ token, origin }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      },
      { token: owner.sessionToken, origin: serviceUrl },
    );
    const projected = connections.map((connection) => ({
      ...coordinates,
      serviceUrl,
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
      cats: [
        { id: 'codex-astra', displayName: 'Astra', supported: true },
        { id: 'unsupported', displayName: 'Other provider', supported: false },
      ],
      bindings: {},
      threads: [],
      requests: [],
      tasks: [],
    };
    const mutations = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === serviceUrl) return route.continue();
      let status = url.pathname === '/api/session' ? 200 : 404;
      let body = {};
      if (url.pathname === '/api/plugins/collective-connector') {
        body = { runtimeStatus: 'active', connections: projected };
        status = 200;
      }
      if (url.pathname.endsWith('/participation')) {
        status = 200;
        if (request.method() === 'PUT') {
          mutations.push({ path: url.pathname, body: request.postDataJSON() });
          view.revision += 1;
          view.published = true;
          view.bindings.astra = {
            catId: 'codex-astra',
            threadId: 'public-fixture',
            participation: { channelIds: ['general'] },
          };
        }
        body = view;
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`${hostUrl}/collective`, { waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: '带猫加入', exact: true }).count(), 0);
    await page.getByLabel('选择 Café 连接').selectOption(connections[1].connectionId);
    await page.getByRole('button', { name: '带猫加入', exact: true }).click();
    await page.getByLabel('选择参与的猫').selectOption('codex-astra');
    const unsupported = page.getByRole('option', { name: 'Other provider · 暂不支持公共参与' });
    assert.equal(
      await unsupported.evaluate((option) => option.disabled),
      true,
      await unsupported.evaluate((option) => option.outerHTML),
    );
    await page.getByRole('button', { name: '带它加入', exact: true }).click();
    await page.getByText('参与设置已发布。', { exact: true }).waitFor();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].path, `/api/plugins/collective-connector/${connections[1].connectionId}/participation`);
    assert.equal(mutations[0].body.standingWork, undefined, 'joining does not grant private execution');
    assert.equal(mutations[0].body.expectedRevision, 1);
    assert.deepEqual(mutations[0].body.channelIds, ['general']);
    await page.screenshot({ path: path.join(evidence, 'owner-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(evidence, 'owner-mobile.png'), fullPage: true });
    for (const control of [
      page.getByLabel('选择 Café 连接'),
      page.getByLabel('选择参与的猫'),
      page.getByRole('button', { name: '更新参与设置', exact: true }),
    ]) {
      const box = await control.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `owner control clipped: ${JSON.stringify(box)}`);
    }
  } finally {
    await page?.close();
    await stopChild(next);
  }
}
