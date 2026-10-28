import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expressionFixture } from './f290-expression.fixture.mjs';

test(
  'ordinary people paste two images, remove one, open the original and survive ACK loss and restart',
  { timeout: 90000 },
  async (t) => {
    const step = (label) => process.stdout.write(`F290 expression: ${label}\n`);
    step('starting real Service and original content owner');
    const fixture = await expressionFixture();
    step('launching browser');
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close();
      await fixture.close();
    });
    const errors = [];
    const openMember = async (token) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(
        ({ origin, token }) => sessionStorage.setItem(`collective-session:${origin}`, token),
        { origin: fixture.url, token },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${fixture.url}/?collectiveId=${fixture.coordinates.collectiveId}&presentation=v2`, {
        waitUntil: 'networkidle',
      });
      await page.getByRole('button', { name: /general/u }).click();
      await page
        .locator('.composer textarea')
        .waitFor()
        .catch(async (error) => {
          if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
            await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({
              path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'failure.png'),
              fullPage: true,
            });
          }
          throw new Error(
            `${error.message}\nPage: ${(await page.locator('body').innerText()).slice(0, 2500)}\nErrors: ${JSON.stringify(errors)}`,
          );
        });
      return { context, page };
    };
    const a = await openMember(fixture.creator.sessionToken);
    step('member A opened general');
    const b = await openMember(fixture.member.sessionToken);
    step('member B opened general');
    const png = Buffer.from(
      await a.page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        context.fillStyle = '#f7f2ea';
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#6b5443';
        context.font = '24px sans-serif';
        context.fillText('Channel image', 36, 96);
        return canvas.toDataURL('image/png').split(',')[1];
      }),
      'base64',
    );
    await a.page.locator('.composer textarea').evaluate((input, base64) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], 'first.png', { type: 'image/png' }));
      transfer.items.add(new File([bytes], 'second.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, png.toString('base64'));
    await a.page.locator('.cafe-attachment-preview[data-status="ready"]').nth(1).waitFor();
    step('two uploads ready');
    await a.page
      .getByRole('button', { name: '移除 second.png', exact: true })
      .click()
      .catch(async (error) => {
        await a.page.screenshot({
          path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR ?? fixture.directory, 'composer-failure.png'),
          fullPage: true,
        });
        const diagnostic = await a.page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.composer-box, .cafe-attachment-previews, .cafe-attachment-preview, .cafe-attachment-remove',
            ),
          ].map((node) => {
            const box = node.getBoundingClientRect(),
              style = getComputedStyle(node);
            return {
              class: node.className,
              position: style.position,
              display: style.display,
              width: box.width,
              height: box.height,
              x: box.x,
              y: box.y,
              hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.className,
            };
          }),
        );
        throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
      });
    assert.equal(await a.page.locator('.cafe-attachment-preview').count(), 1);
    await a.page.locator('.composer textarea').fill('只发这一张 · ordinary image');
    await a.page.reload({ waitUntil: 'networkidle' });
    step('private draft reloaded');
    await a.page.locator('.cafe-attachment-preview[data-status="ready"]').waitFor();
    assert.equal(await a.page.locator('.composer textarea').inputValue(), '只发这一张 · ordinary image');
    assert.equal(
      await b.page.locator('.composer textarea').inputValue(),
      '',
      'Private drafts must stay with their Human',
    );
    let lostAck = false;
    await a.page.route('**/api/events/human', async (route) => {
      if (route.request().method() !== 'POST' || lostAck) return route.continue();
      lostAck = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await a.page.locator('output.delivery-failed').waitFor();
    step('ACK deliberately lost; retrying');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await b.page.getByRole('img', { name: 'first.png', exact: true }).waitFor();
    assert.equal(await b.page.getByRole('img', { name: 'second.png', exact: true }).count(), 0);
    const event = (
      await fixture.store.listEventsForHuman(fixture.member.sessionToken, fixture.coordinates.collectiveId)
    ).find((item) => item.body === '只发这一张 · ordinary image');
    assert.ok(event);
    assert.equal(event.attachments.length, 1);
    const readQuery = new URLSearchParams({
      ...fixture.coordinates,
      attachmentId: event.attachments[0].attachmentId,
      sourceEventId: event.eventId,
    });
    const readResponse = await fetch(`${fixture.url}/api/message-attachments/read?${readQuery}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.member.sessionToken}` },
    });
    assert.equal(readResponse.status, 200);
    assert.deepEqual(
      Buffer.from(await readResponse.arrayBuffer()),
      png,
      'The original owner bytes must reach the second member unchanged',
    );
    assert.ok(
      await b.page.getByRole('img', { name: 'first.png', exact: true }).evaluate(async (image) => {
        await image.decode();
        return image.naturalWidth > 0;
      }),
    );
    await b.page.getByRole('button', { name: '打开原图：first.png', exact: true }).click();
    await b.page.getByRole('dialog', { name: 'first.png' }).waitFor();
    await b.page.getByRole('button', { name: '回到原消息', exact: true }).click();
    step('original opened and returned');
    await b.page.locator(`#collective-event-${event.eventId}`).waitFor();
    await b.page.locator(`#collective-event-${event.eventId} .message-markdown`).evaluate((body) => {
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await b.page.getByRole('button', { name: '引用到聊天', exact: true }).click();
    await b.page.locator('.composer .message-quote').waitFor();
    await b.page.reload({ waitUntil: 'networkidle' });
    await b.page.locator('.composer .message-quote').waitFor();
    await b.page.getByRole('button', { name: '发送', exact: true }).click();
    await a.page.locator('.channel-flow .message-quote').waitFor();
    const quoteEvent = (
      await fixture.store.listEventsForHuman(fixture.creator.sessionToken, fixture.coordinates.collectiveId)
    ).find((item) => item.contextAttachments?.some((quote) => quote.source.eventId === event.eventId));
    assert.ok(quoteEvent, 'A sourced quote is public content, not a private draft-only preview');
    assert.equal(quoteEvent.body, '');
    await a.page.locator('.channel-flow .message-quote header button').first().click();
    await a.page.locator(`#collective-event-${event.eventId}`).waitFor();
    step('selected quote restored, sent and returned to its public source');
    await a.page.waitForFunction(() => !document.querySelector('.composer .cafe-attachment-preview'));
    await a.page
      .locator('input[type=file]')
      .setInputFiles({ name: 'ack-recovery.png', mimeType: 'image/png', buffer: png });
    await a.page.locator('.cafe-attachment-preview[data-status="ready"]').waitFor();
    await a.page.locator('.composer textarea').fill('已接收但没有回执');
    lostAck = false;
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await a.page.locator('output.delivery-failed').waitFor();
    await a.page.reload({ waitUntil: 'networkidle' });
    step('reloading after second lost ACK');
    await a.page.waitForFunction(
      () =>
        document.querySelector('.composer textarea')?.value === '' &&
        !document.querySelector('.composer .cafe-attachment-preview'),
    );
    assert.equal(
      (await fixture.store.listEventsForHuman(fixture.member.sessionToken, fixture.coordinates.collectiveId)).filter(
        (item) => item.body === '已接收但没有回执',
      ).length,
      1,
    );
    await fixture.restart();
    step('Service restarted');
    await b.page.reload({ waitUntil: 'networkidle' });
    await b.page.getByRole('img', { name: 'first.png', exact: true }).waitFor();
    await b.page.getByRole('button', { name: '更多输入选项', exact: true }).click();
    await b.page.getByRole('button', { name: '贴纸', exact: true }).click();
    const picker = b.page.getByRole('dialog', { name: '贴纸', exact: true });
    await picker.waitFor();
    assert.equal(await picker.locator('.cafe-sticker-tile').count(), 16);
    await picker.getByRole('button', { name: '梵花猫', exact: true }).click();
    if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
      await picker.getByRole('button', { name: '好耶 · 梵花猫', exact: true }).waitFor({ state: 'visible' });
      await b.page.screenshot({
        path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'sticker-picker-1440.png'),
        fullPage: true,
      });
    }
    await picker.getByRole('button', { name: '好耶 · 梵花猫', exact: true }).click();
    await b.page.locator('.cafe-attachment-preview[data-status="ready"]').waitFor();
    await b.page.reload({ waitUntil: 'networkidle' });
    await b.page.locator('.cafe-attachment-preview[data-status="ready"]').waitFor();
    await b.page.getByRole('button', { name: '发送', exact: true }).click();
    await b.page.waitForFunction(() => !document.querySelector('.composer .cafe-attachment-preview'));
    const stickerEvent = (
      await fixture.store.listEventsForHuman(fixture.member.sessionToken, fixture.coordinates.collectiveId)
    ).find((item) => item.attachments?.some((attachment) => attachment.sticker?.stickerId === 'momo-cheer'));
    assert.ok(stickerEvent, 'A selected original sticker survives a private draft reload and reaches the other member');
    await a.page.locator(`#collective-event-${stickerEvent.eventId}`).scrollIntoViewIfNeeded();
    const sticker = a.page.locator('.channel-flow .cafe-message-sticker img');
    await sticker.waitFor();
    assert.equal(await sticker.getAttribute('alt'), '好耶 · 梵花猫');
    assert.ok(
      await sticker.evaluate(async (image) => {
        await image.decode();
        return image.naturalWidth > 0;
      }),
    );
    if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
      await a.page.screenshot({
        path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'sticker-message-1440.png'),
        fullPage: true,
      });
    }
    step('shared sticker catalogue sent its original image through the ordinary durable attachment path');
    const a2 = await openMember(fixture.creator.sessionToken);
    await a.page.locator('.composer textarea').fill('窗口一的私人草稿');
    await a.page.waitForResponse(
      (response) => response.url().endsWith('/api/channel-state/draft') && response.status() === 200,
    );
    await a2.page.locator('.composer textarea').fill('窗口二的私人草稿');
    await a2.page.getByRole('button', { name: '载入保存的草稿', exact: true }).waitFor();
    assert.equal(await a2.page.locator('.composer textarea').inputValue(), '窗口二的私人草稿');
    await a2.page.getByRole('button', { name: '载入保存的草稿', exact: true }).click();
    assert.equal(await a2.page.locator('.composer textarea').inputValue(), '窗口一的私人草稿');
    await a2.context.close();
    step('two-window conflict preserved and explicitly resolved');
    if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
      await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
      await b.page.screenshot({
        path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'channel-image-1440.png'),
        fullPage: true,
      });
      await writeFile(
        join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'first-slice.json'),
        JSON.stringify(
          {
            identityMode: 'independent-test-sessions; no real OAuth or human acceptance',
            lostAck,
            eventId: event.eventId,
            attachmentCount: event.attachments.length,
            firstMessageCopies: (
              await fixture.store.listEventsForHuman(fixture.member.sessionToken, fixture.coordinates.collectiveId)
            ).filter((item) => item.body === '只发这一张 · ordinary image').length,
            restartRead: true,
            privateDraftRefresh: true,
            lostAckReloadClearsConsumedFiles: true,
            concurrentDraftConflict: 'both preserved; explicit load saved draft',
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
    }
    await b.page.setViewportSize({ width: 390, height: 844 });
    await b.page.screenshot({
      path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR ?? fixture.directory, 'channel-image-390.png'),
      fullPage: true,
    });
    assert.ok(
      await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Narrow layout must not overflow',
    );
    const longBody = `长消息起点\n\n${Array.from({ length: 120 }, (_, i) => `这是长消息的第 ${i + 1} 行，滚到底才读到结尾。`).join('\n\n')}`;
    await a.page.locator('.composer textarea').fill(longBody);
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await b.page.getByText('长消息起点', { exact: true }).waitFor();
    const longEvent = (
      await fixture.store.listEventsForHuman(fixture.member.sessionToken, fixture.coordinates.collectiveId)
    ).find((item) => item.body === longBody);
    assert.ok(longEvent);
    await b.page.bringToFront();
    await b.page.waitForTimeout(600);
    assert.ok(
      fixture.store.readHumanChannelState(fixture.member.sessionToken, { ...fixture.coordinates, channelId: 'general' })
        .read.sequence < longEvent.sequence,
      'Seeing the start of a tall message must not mark its unseen end as read',
    );
    await b.page.locator(`#collective-event-${longEvent.eventId} .message-body`).evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await b.page.locator('.channel-flow').evaluate((flow) => {
      flow.scrollTop = flow.scrollHeight;
    });
    await b.page.waitForFunction(
      async ({ coordinates, sequence }) => {
        const token = sessionStorage.getItem(`collective-session:${location.origin}`);
        const result = await fetch(
          `/api/channel-state?${new URLSearchParams({ ...coordinates, channelId: 'general' })}`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        return (await result.json()).read.sequence >= sequence;
      },
      { coordinates: fixture.coordinates, sequence: longEvent.sequence },
    );
    step('actually reading the end of a tall message advanced only this member cursor');
    assert.deepEqual(errors, []);
    await a.context.close();
    await b.context.close();
  },
);
