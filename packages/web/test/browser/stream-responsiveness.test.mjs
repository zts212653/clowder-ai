import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild-wasm';
import { chromium, _electron as electron } from 'playwright';
import { ResponseStreamRecords } from '../../../api/src/infrastructure/websocket/ResponseStreamRecords.ts';

test(
  'large real stream queues yield to frames and timers without losing their bodies',
  { timeout: 120000 },
  async () => {
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const evidence = path.resolve(web, '../../artifacts/issue1968');
    await mkdir(evidence, { recursive: true });
    const bundle = await build({
      entryPoints: [path.join(web, 'test/browser/fixtures/stream-responsiveness.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      globalName: 'StreamResponsiveness',
      alias: { '@': path.join(web, 'src'), '@cat-cafe/shared': path.resolve(web, '../shared/src/index.ts') },
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    });
    const records = new ResponseStreamRecords();
    const threadId = 'isolated-diagnostic-thread';
    const messageId = 'isolated-diagnostic-response';
    records.open({ id: messageId, threadId });
    Array.from({ length: 10000 }, (_, index) =>
      records.record(
        {
          threadId,
          messageId,
          catId: 'diagnostic',
          timestamp: index + 2,
          type: index % 2 === 0 ? 'tool_use' : 'tool_result',
          toolEventId: `tool-${index}`,
          toolUseId: `call-${Math.floor(index / 2)}`,
          toolName: 'synthetic-tool',
          content: 'x'.repeat(32),
        },
        threadId,
      ),
    );
    const [entry] = records.forThread(threadId);
    assert.equal(entry.complete, true);
    assert.equal(entry.events.length, 10000);
    const replay = {
      threadId,
      joinId: 'isolated-join',
      responses: [
        {
          messageId,
          catId: 'diagnostic',
          timestamp: 1,
          complete: entry.complete,
          nextIndex: entry.nextIndex,
          events: entry.events,
        },
      ],
    };
    let application;
    let browser;
    let page;
    let electronPid;
    if (process.env.ELECTRON_EXECUTABLE_PATH) {
      const main = path.join(evidence, 'electron-probe.cjs');
      await mkdir(path.join(evidence, 'electron-user-data'), { recursive: true });
      await writeFile(
        main,
        `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(evidence, 'electron-user-data'))});
app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});win.loadURL('about:blank');});
app.on('window-all-closed',()=>app.quit());`,
        'utf8',
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      application = await electron.launch({
        executablePath: process.env.ELECTRON_EXECUTABLE_PATH,
        args: ['--no-sandbox', '--disable-gpu', '--enable-logging=stderr', main],
        env,
      });
      electronPid = application.process().pid;
      page = await application.firstWindow();
    } else {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      page = await browser.newPage();
    }
    const errors = [];
    const requests = [];
    const results = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));
    await page.route('**/*', (route) => route.abort());
    try {
      for (const input of [
        { count: 20000, history: 1000 },
        { count: 10000, replay },
      ]) {
        await page.setContent('<!doctype html><title>Isolated stream responsiveness</title><p>Synthetic data only</p>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const { body, ...result } = await page.evaluate((input) => StreamResponsiveness.measure(input), input);
        const bodySha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        results.push({ kind: input.replay ? 'replay-tools' : 'live-burst', ...result, bodySha256 });
        assert.equal(result.processed, input.count);
        assert.equal(body.content.length, input.replay ? 0 : 640000);
        assert.equal(body.toolEvents?.length ?? 0, input.replay ? 10000 : 0);
        assert(result.timerMs < result.finishedMs, 'a timer must run before the queue is exhausted');
        assert(result.frameMs < result.finishedMs, 'a frame must run before the queue is exhausted');
        assert(result.frames > 2);
        assert(result.maxFrameGap < 500, `unexpected long frame gap: ${result.maxFrameGap}ms`);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
    } finally {
      if (application) await application.close();
      if (browser) await browser.close();
      const report = {
        electronPid,
        environment: process.env.ELECTRON_EXECUTABLE_PATH ? 'Electron' : 'Chromium',
        results,
        errors,
        requests,
        closed: true,
      };
      await writeFile(path.join(evidence, `green-${report.environment}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
    }
  },
);
