import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expressionFixture } from './f290-expression.fixture.mjs';
import { expressionHostFixture, expressionVoiceServiceFixture } from './f290-expression-voice.fixture.mjs';

test(
  'the real product iframe records with delegated permission and keeps stopped audio/transcription in the original private draft',
  { timeout: 120000 },
  async (t) => {
    const step = (label) => process.stdout.write(`F290 voice: ${label}\n`);
    const host = await expressionHostFixture();
    t.after(() => host.close());
    const fixture = await expressionFixture({ allowedHostOrigins: [host.url] });
    t.after(() => fixture.close());
    host.setService(fixture.url);
    const service = await expressionVoiceServiceFixture();
    t.after(() => service.close());
    await fixture.store.postHumanMessage(fixture.creator.sessionToken, {
      ...fixture.coordinates,
      clientEventId: 'voice-other-channel',
      body: 'Explicit test Channel',
      location: { channelId: 'other' },
      recipient: { kind: 'channel' },
    });
    const browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
    t.after(() => browser.close());
    // The recording browser's fake UI deliberately auto-grants access. A separate browser exercises real denial.
    const deniedBrowser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream'] });
    t.after(() => deniedBrowser.close());
    const errors = [];
    const open = async (token, permission) => {
      const context = await (permission ? browser : deniedBrowser).newContext({
        viewport: { width: 1440, height: 1000 },
      });
      if (permission) {
        await context.grantPermissions(['microphone'], { origin: host.url });
        await context.grantPermissions(['microphone'], { origin: fixture.url });
      }
      await context.addInitScript(
        ({ origin, token }) => {
          localStorage.setItem('cat-cafe:shell-presentation', 'v2');
          if (location.origin === origin) {
            sessionStorage.setItem(`collective-session:${origin}`, token);
            const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            window.__voiceFixtureStreams = [];
            navigator.mediaDevices.getUserMedia = async (constraints) => {
              try {
                const stream = await original(constraints);
                window.__voiceFixtureStreams.push(stream);
                return stream;
              } catch (error) {
                window.__voiceFixtureError = { name: error.name, message: error.message, stack: error.stack };
                throw error;
              }
            };
          }
        },
        { origin: fixture.url, token },
      );
      const page = await context.newPage();
      const requests = [];
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        requests.push(`${url.origin}${url.pathname}`);
        if (['3001', '3002'].includes(url.port)) {
          errors.push('Unexpected runtime origin');
          return route.abort();
        }
        return route.continue();
      });
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${host.url}/collective`, { waitUntil: 'networkidle' });
      await page
        .locator('iframe[title="Collective"]')
        .waitFor()
        .catch(async (error) => {
          if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
            await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({
              path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'voice-host-failure.png'),
              fullPage: true,
            });
          }
          throw new Error(
            `${error.message}\nHost: ${(await page.locator('body').innerText()).slice(0, 1800)}\nErrors: ${JSON.stringify(errors)}\nRequests: ${JSON.stringify(requests.slice(-12))}`,
          );
        });
      assert.equal(await page.locator('iframe').getAttribute('allow'), 'microphone');
      const frame = page.frameLocator('iframe[title="Collective"]');
      await frame.getByRole('button', { name: '先逛逛', exact: true }).click();
      await frame.getByRole('button', { name: /general/u }).click();
      await frame.locator('.composer[data-draft-ready="true"]').waitFor();
      return { context, page, frame };
    };
    const a = await open(fixture.creator.sessionToken, false);
    const b = await open(fixture.member.sessionToken, true);
    const unavailable = '这台设备上还不能语音输入';
    assert.equal(await a.frame.getByRole('button', { name: unavailable, exact: true }).isDisabled(), true);
    const configure = async (member) => {
      await member.frame.getByRole('button', { name: '更多输入选项', exact: true }).click();
      await member.frame.getByRole('button', { name: '语音设置', exact: true }).click();
      await member.frame.getByRole('textbox', { name: '本机转写服务地址', exact: true }).fill(service.url);
      await member.frame.getByRole('button', { name: '检查并启用', exact: true }).click();
      await member.frame
        .getByRole('button', { name: '语音输入', exact: true })
        .waitFor()
        .catch(async (error) => {
          throw new Error(`${error.message}\nClient: ${(await member.frame.locator('body').innerText()).slice(-1800)}`);
        });
    };
    // The top-level page and iframe are different origins. Permission is delegated by the real launch component.
    await configure(b);
    assert.equal(
      await a.frame.getByRole('button', { name: unavailable, exact: true }).isDisabled(),
      true,
      'B configuring their current-device service must not enable A by borrowing B’s Café',
    );
    step('real Host iframe and explicit current-Human device service ready');
    await b.frame.locator('.composer textarea').fill('原频道原草稿');
    await b.frame.getByRole('button', { name: '语音输入', exact: true }).click();
    await b.frame.getByRole('button', { name: '停止录音', exact: true }).waitFor();
    await b.frame
      .locator('.composer-voice-status')
      .getByText(/0:01/u)
      .waitFor()
      .catch(async (error) => {
        const frame = b.page.frames().find((item) => item.url().startsWith(fixture.url));
        throw new Error(
          `${error.message}\nVoice: ${await b.frame.locator('.composer-voice-status').innerText()}\nCapture: ${JSON.stringify(
            await frame.evaluate(async () => ({
              permission: (await navigator.permissions.query({ name: 'microphone' })).state,
              allowed: document.featurePolicy?.allowsFeature('microphone'),
              error: window.__voiceFixtureError,
              secure: isSecureContext,
              streams: window.__voiceFixtureStreams.map((stream) =>
                stream.getTracks().map((track) => ({ state: track.readyState, enabled: track.enabled })),
              ),
            })),
          )}\nErrors: ${JSON.stringify(errors)}`,
        );
      });
    await b.frame.getByRole('button', { name: /other/u }).click();
    await b.frame.locator('.composer[data-draft-ready="true"]').waitFor();
    const request = await service.next();
    assert.ok(request.bytes > 0);
    const clientFrame = b.page.frames().find((frame) => frame.url().startsWith(fixture.url));
    assert.ok(clientFrame);
    assert.ok(
      await clientFrame.evaluate(() =>
        window.__voiceFixtureStreams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === 'ended'),
        ),
      ),
    );
    await b.frame.locator('.composer textarea').fill('新频道的文字不被替换');
    await b.frame.getByRole('button', { name: /general/u }).click();
    await b.frame.locator('.composer[data-draft-ready="true"]').waitFor();
    request.complete('原录音转出的文字');
    await clientFrame.waitForFunction(
      () => document.querySelector('.composer textarea')?.value === '原频道原草稿\n原录音转出的文字',
    );
    assert.equal(await b.frame.getByRole('button', { name: '发送', exact: true }).isEnabled(), true);
    await b.frame.getByRole('button', { name: /other/u }).click();
    await b.frame.locator('.composer[data-draft-ready="true"]').waitFor();
    assert.equal(await b.frame.locator('.composer textarea').inputValue(), '新频道的文字不被替换');
    await b.frame.getByRole('button', { name: /general/u }).click();
    await b.frame.locator('.composer[data-draft-ready="true"]').waitFor();
    step('navigation stopped tracks immediately; returning before ASR finished preserved the correct private draft');
    if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
      await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
      await b.page.screenshot({
        path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'voice-private-draft-1440.png'),
        fullPage: true,
      });
    }
    await b.frame.getByRole('button', { name: '移除录音', exact: true }).click();
    const mic = b.frame.getByRole('button', { name: '语音输入', exact: true });
    await mic.click();
    await b.frame.getByRole('button', { name: '停止录音', exact: true }).waitFor();
    await b.frame.locator('.composer-voice-status').getByText(/0:01/u).waitFor();
    await b.frame.getByRole('button', { name: '停止录音', exact: true }).click();
    const failed = await service.next();
    failed.fail();
    await b.frame.getByRole('button', { name: '再试一次', exact: true }).waitFor();
    await b.page.waitForTimeout(350); // existing private draft debounce before deliberate browser reload
    await b.page.reload({ waitUntil: 'networkidle' });
    await b.frame.getByRole('button', { name: /general/u }).click();
    await b.frame.locator('.composer[data-draft-ready="true"]').waitFor();
    await b.frame
      .getByRole('button', { name: '再试一次', exact: true })
      .click()
      .catch(async (error) => {
        throw new Error(`${error.message}\nAfter refresh: ${(await b.frame.locator('body').innerText()).slice(-2600)}`);
      });
    const retried = await service.next();
    assert.equal(retried.bytes, failed.bytes, 'Retry uses the retained original recording after browser refresh');
    retried.complete('刷新后重试的文字');
    const returned = b.page.frames().find((frame) => frame.url().startsWith(fixture.url));
    await returned.waitForFunction(() =>
      document.querySelector('.composer textarea')?.value.includes('刷新后重试的文字'),
    );
    const publicBeforeSend = await fixture.store.listEventsForHuman(
      fixture.creator.sessionToken,
      fixture.coordinates.collectiveId,
    );
    assert.ok(
      !publicBeforeSend.some((event) => event.body.includes('原录音转出的文字')),
      'Transcription is private and must never send itself',
    );
    await b.frame.getByRole('button', { name: '发送', exact: true }).click();
    await a.frame.getByText(/刷新后重试的文字/u).waitFor();
    const sent = (
      await fixture.store.listEventsForHuman(fixture.creator.sessionToken, fixture.coordinates.collectiveId)
    ).find((event) => event.body.includes('刷新后重试的文字'));
    assert.ok(sent && !('voiceDraft' in sent) && !sent.workRequest && !sent.attachments?.length);
    step(
      'failed ASR retained audio through refresh; retry produced editable text and explicit Send published only the words',
    );
    await configure(a);
    const cdp = await a.context.newCDPSession(a.page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', {
      permission: { name: 'microphone' },
      setting: 'denied',
      origin: host.url,
      embeddedOrigin: fixture.url,
      browserContextId: targetInfo.browserContextId,
    });
    await a.frame.locator('.composer textarea').fill('拒绝权限后保留这句话');
    await a.frame.getByRole('button', { name: '语音输入', exact: true }).click();
    await a.frame.locator('.composer-voice-status[data-voice-status="failed"]').waitFor();
    assert.equal(await a.frame.locator('.composer textarea').inputValue(), '拒绝权限后保留这句话');
    step('browser microphone denial preserved the original draft at the actual product entry');
    assert.deepEqual(errors, []);
    await a.context.close();
    await b.context.close();
  },
);
