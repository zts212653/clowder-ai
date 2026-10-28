import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

function tone() {
  const samples = 8000,
    data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(2000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), 44 + i * 2);
  return data;
}

test(
  'independent member browsers upload, publish and read original image/file/audio/sticker bytes through SSH',
  { timeout: 90_000 },
  async (t) => {
    const directory = process.env.F290_SSH_DATA_DIR,
      output = process.env.F290_SSH_EVIDENCE_DIR;
    assert.ok(directory && output, 'An operator-owned isolated Service and evidence directory are required');
    const f = JSON.parse(await readFile(join(directory, 'isolated-browser-sessions.json'), 'utf8'));
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const errors = [];
    async function open(token) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(
        ({ origin, token }) => {
          if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        },
        { origin: f.origin, token },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(f.origin, { waitUntil: 'networkidle' });
      const browse = page.getByRole('button', { name: /先逛逛|Browse first/u });
      if (await browse.isVisible()) await browse.click();
      if (!(await page.locator('.composer textarea').isVisible()))
        await page.getByRole('button', { name: /general/u }).click();
      await page.locator('.composer[data-draft-ready="true"]').waitFor();
      return page;
    }
    const a = await open(f.owner.sessionToken),
      b = await open(f.member.sessionToken);
    const png = await readFile(join(directory, 'stickers/memory/yanyan-applied.png'));
    const text = Buffer.from('SSH original file · 原始正文');
    const audio = tone();
    await a.getByLabel('添加文件', { exact: true }).setInputFiles([
      { name: 'ssh-picture.png', mimeType: 'image/png', buffer: png },
      { name: 'ssh-notes.txt', mimeType: 'text/plain', buffer: text },
      { name: 'ssh-tone.wav', mimeType: 'audio/wav', buffer: audio },
    ]);
    await a.locator('.cafe-attachment-preview[data-status="ready"]').nth(2).waitFor();
    const body = `SSH 独立保管验证 ${Date.now()}`;
    await a.locator('.composer textarea').fill(body);
    const published = a.waitForResponse(
      (response) => response.url().endsWith('/api/events/human') && response.request().method() === 'POST',
    );
    await a.getByRole('button', { name: '发送', exact: true }).click();
    const response = await published;
    assert.equal(response.status(), 201);
    const event = await response.json();
    await b.getByText(body, { exact: true }).waitFor();
    const article = b.locator(`[data-event-id="${event.eventId}"]`);
    await article.scrollIntoViewIfNeeded();
    const image = article.getByRole('img', { name: 'ssh-picture.png', exact: true });
    await image.waitFor();
    assert.ok(
      await image.evaluate(async (element) => {
        await element.decode();
        return element.naturalWidth > 0;
      }),
    );
    for (const name of ['ssh-notes.txt', 'ssh-tone.wav'])
      await article.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click();
    await article.locator('audio').waitFor();
    await article.locator('audio').evaluate(async (element) => {
      element.muted = true;
      await element.play();
    });
    await b.waitForFunction(
      (id) => document.querySelector(`[data-event-id="${id}"] audio`)?.currentTime > 0,
      event.eventId,
    );
    for (const [name, bytes] of [
      ['ssh-picture.png', png],
      ['ssh-notes.txt', text],
      ['ssh-tone.wav', audio],
    ]) {
      const attachment = event.attachments.find((item) => item.fileName === name);
      assert.ok(attachment);
      assert.equal(attachment.blobDigest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      const query = new URLSearchParams({
        serviceInstanceId: f.serviceInstanceId,
        collectiveId: f.collectiveId,
        attachmentId: attachment.attachmentId,
        sourceEventId: event.eventId,
      });
      const received = await fetch(`${f.origin}/api/message-attachments/read?${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${f.member.sessionToken}`, range: 'bytes=0-7' },
      });
      assert.equal(received.status, 206);
      assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes.subarray(0, 8));
    }
    await b.getByRole('button', { name: '更多输入选项', exact: true }).click();
    await b.getByRole('button', { name: '贴纸', exact: true }).click();
    const picker = b.getByRole('dialog', { name: '贴纸', exact: true });
    await picker.getByRole('button', { name: '梵花猫', exact: true }).click();
    await picker.getByRole('button', { name: '好耶 · 梵花猫', exact: true }).click();
    await b.locator('.cafe-attachment-preview[data-status="ready"]').waitFor();
    const stickerPublished = b.waitForResponse(
      (response) => response.url().endsWith('/api/events/human') && response.request().method() === 'POST',
    );
    await b.getByRole('button', { name: '发送', exact: true }).click();
    const stickerEvent = await (await stickerPublished).json();
    const sticker = a.locator(`[data-event-id="${stickerEvent.eventId}"] .cafe-message-sticker img`);
    await sticker.waitFor();
    assert.ok(
      await sticker.evaluate(async (element) => {
        await element.decode();
        return element.naturalWidth > 0;
      }),
    );
    assert.equal(stickerEvent.attachments[0].sticker.stickerId, 'momo-cheer');
    await mkdir(output, { recursive: true });
    await a.screenshot({ path: join(output, 'ssh-member-a.png'), fullPage: true });
    await b.screenshot({ path: join(output, 'ssh-member-b.png'), fullPage: true });
    await b.setViewportSize({ width: 390, height: 844 });
    await b.screenshot({ path: join(output, 'ssh-member-b-narrow.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await writeFile(
      join(output, 'ssh-members.json'),
      JSON.stringify(
        {
          serviceInstanceId: f.serviceInstanceId,
          collectiveId: f.collectiveId,
          eventId: event.eventId,
          attachments: event.attachments,
          stickerEventId: stickerEvent.eventId,
          provider: 'fixture',
          browserContexts: 2,
          actualSshForward: f.origin,
          byteRanges: 'verified',
          audio: 'synthetic PCM decoded and played; no physical-device claim',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Two isolated member browsers completed original image/file/audio/sticker reads through the actual SSH forward.',
    );
  },
);
