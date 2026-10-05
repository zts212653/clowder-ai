import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';

test(
  'an ordinary member leaves cleanly while public history and revoked authority survive restart',
  { timeout: 90_000 },
  async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-member-exit-service-'));
    const evidence = await mkdtemp(path.join(tmpdir(), 'f290-member-exit-evidence-'));
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: defaultHumanAuthProvider(),
    });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const memberPairing = await opened.store.createPairingIntent({
      sessionToken: seeded.member.sessionToken,
      collectiveId: seeded.coordinates.collectiveId,
      hostOrigin: 'http://localhost:5191',
      nonce: 'member-clean-exit-browser-pairing',
    });
    const memberConnection = await opened.store.exchangePairingIntent({
      ...memberPairing,
      endpointLabel: '吴浪的 Café',
    });
    let service = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
    const serviceUrl = service.url;
    let browser;

    try {
      browser = await chromium.launch({ headless: true });
      const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const memberContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installSession(ownerContext, serviceUrl, seeded.owner.sessionToken);
      await installSession(memberContext, serviceUrl, seeded.member.sessionToken);
      const ownerPage = await ownerContext.newPage();
      const memberPage = await memberContext.newPage();
      const errors = [];
      ownerPage.on('pageerror', (error) => errors.push(`owner:${error.message}`));
      memberPage.on('pageerror', (error) => errors.push(`member:${error.message}`));

      await Promise.all([
        ownerPage.goto(serviceUrl, { waitUntil: 'networkidle' }),
        memberPage.goto(serviceUrl, { waitUntil: 'networkidle' }),
      ]);
      await memberPage
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await memberPage.getByRole('heading', { name: '# 产品方向', exact: true }).waitFor();
      await memberPage.getByText('讨论在这里发生，每个 Café 仍然保留自己的边界。', { exact: true }).waitFor();
      await memberPage.getByRole('button', { name: '退出共同家园', exact: true }).waitFor();
      await memberPage.screenshot({ path: path.join(evidence, 'member-before-exit-1440.png'), fullPage: true });

      await memberPage.setViewportSize({ width: 390, height: 844 });
      await memberPage.getByRole('button', { name: '频道导航', exact: true }).click();
      const exitButton = memberPage.getByRole('button', { name: '退出共同家园', exact: true });
      await exitButton.waitFor();
      const exitTarget = await exitButton.boundingBox();
      assert.ok(
        exitTarget && exitTarget.width >= 44 && exitTarget.height >= 44,
        'mobile exit action needs a 44px target',
      );
      assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await memberPage.screenshot({ path: path.join(evidence, 'member-before-exit-mobile.png'), fullPage: true });

      memberPage.once('dialog', (dialog) => dialog.accept());
      await exitButton.click();
      await memberPage.getByRole('heading', { name: '建立新的共同家园', exact: true }).waitFor();
      assert.equal(new URL(memberPage.url()).searchParams.has('collectiveId'), false);
      assert.equal(await memberPage.getByText('讨论在这里发生，每个 Café 仍然保留自己的边界。').count(), 0);
      assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await memberPage.screenshot({ path: path.join(evidence, 'member-after-exit-mobile.png'), fullPage: true });

      await ownerPage
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await ownerPage.getByText('讨论在这里发生，每个 Café 仍然保留自己的边界。', { exact: true }).waitFor();
      await ownerPage
        .getByRole('navigation', { name: '共同家园成员', exact: true })
        .getByRole('button', { name: /成员/ })
        .click();
      const directory = ownerPage.getByRole('complementary', { name: '成员', exact: true });
      await directory.waitFor();
      await directory.getByText('吴浪', { exact: true }).waitFor({ state: 'detached' });
      await ownerPage.screenshot({ path: path.join(evidence, 'owner-history-after-exit-1440.png'), fullPage: true });
      const revokedConnection = await opened.store.getConnectionProjection(memberConnection.connectionId);
      assert.equal(revokedConnection.status, 'revoked');
      assert.equal(revokedConnection.revocationReason, 'membership_left');
      assert.equal(revokedConnection.authorizedHumanId, seeded.member.human.humanId);
      assert.ok(revokedConnection.revokedAt);

      await service.close();
      const reopened = await CollectiveServiceStore.open({
        dataDirectory,
        humanAuthProvider: defaultHumanAuthProvider(),
      });
      service = await startCollectiveServer({
        store: reopened.store,
        host: '127.0.0.1',
        port: Number(new URL(serviceUrl).port),
      });
      await Promise.all([
        ownerPage.reload({ waitUntil: 'networkidle' }),
        memberPage.reload({ waitUntil: 'networkidle' }),
      ]);
      await ownerPage
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await ownerPage.getByText('讨论在这里发生，每个 Café 仍然保留自己的边界。', { exact: true }).waitFor();
      await memberPage.getByRole('heading', { name: '建立新的共同家园', exact: true }).waitFor();
      await assert.rejects(
        reopened.store.pollEvents(memberConnection.endpointCredential, {
          ...seeded.coordinates,
          connectionId: memberConnection.connectionId,
          afterSequence: 0,
          limit: 10,
        }),
        (error) => error?.code === 'CONNECTION_REVOKED',
      );
      assert.deepEqual(errors, []);

      console.log(
        JSON.stringify({
          result: 'pass',
          evidence,
          tested: [
            'member-visible-exit',
            'mobile-exit-and-next-step',
            'mobile-exit-44px-target',
            'atomic-membership-and-cafe-revoke',
            'public-history-retained',
            'member-directory-removed',
            'restart-no-authority-revival',
          ],
          data: 'isolated Service fixture; not real GitHub two-Human UAT',
        }),
      );
    } catch (error) {
      console.error(JSON.stringify({ result: 'fail', evidence }));
      throw error;
    } finally {
      await browser?.close();
      await service.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  },
);

async function installSession(context, origin, token) {
  await context.addInitScript(
    ({ expectedOrigin, sessionToken }) => {
      if (location.origin === expectedOrigin) {
        sessionStorage.setItem(`collective-session:${expectedOrigin}`, sessionToken);
      }
    },
    { expectedOrigin: origin, sessionToken: token },
  );
}
