import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';
import { detectChromePath } from '../../../services/image-export-browser-session.js';
import { runBrowserWorker } from './browser-bootstrap.js';
import { monitorPrivateBrowser } from './process-budget.js';

const WIRE_BUDGET = 12 * 1024 * 1024;
const MODULE_BUDGET = 16 * 1024 * 1024;
const WORKER_POLICY = "default-src 'none'; script-src 'none'; connect-src 'none'; worker-src 'none'; object-src 'none'";

/** Receives no package path, credential, owner handle or authority object. All
 * responses remain untrusted; the caller validates the public protocol and lease.
 */
export async function runContainedMaterializer(options: {
  readonly module: Buffer;
  readonly requestJson: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}) {
  options.signal.throwIfAborted();
  if (options.timeoutMs !== undefined && !Number.isFinite(options.timeoutMs))
    throw new Error('invalid materializer deadline');
  if (Buffer.byteLength(options.requestJson) > WIRE_BUDGET || options.module.length > MODULE_BUDGET) {
    throw new Error('materializer input budget exceeded');
  }
  JSON.parse(options.requestJson);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('sandbox resource monitor unavailable');
  const started = performance.now();
  const controller = new AbortController();
  const revoke = () => controller.abort(new Error('materializer authority revoked'));
  options.signal.addEventListener('abort', revoke, { once: true });
  const timeoutMs = Math.min(20_000, Math.max(100, options.timeoutMs ?? 20_000));
  const deadline = setTimeout(() => controller.abort(new Error('materializer deadline exceeded')), timeoutMs);
  let profile: string | undefined;
  let browser: Browser | undefined;
  let monitor: Awaited<ReturnType<typeof monitorPrivateBrowser>> | undefined;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Attach before launching; all launch and execution stages share the deadline.
  const onAbort = () => {
    try {
      monitor?.kill();
    } catch (error) {
      rejectAbort(error);
      return;
    }
    rejectAbort(controller.signal.reason);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) revoke();
  let externalRequests = 0;
  let json = '';
  let execution: Promise<string> | undefined;
  let completed = false;
  try {
    const execute = async () => {
      const directory = await mkdtemp(join(tmpdir(), 'clowder-materializer-'));
      profile = directory;
      controller.signal.throwIfAborted();
      browser = await puppeteer.launch({
        executablePath: detectChromePath(),
        headless: true,
        pipe: true,
        userDataDir: directory,
        signal: controller.signal,
        timeout: timeoutMs,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: directory },
        args: ['--js-flags=--max-old-space-size=256', '--disable-quic', '--disable-features=MediaRouter'],
      });
      controller.signal.throwIfAborted();
      const child = browser.process();
      if (
        !child?.pid ||
        child.spawnargs.some((arg) => /--(?:no-sandbox|disable-.*sandbox|single-process)(?:=|$)/.test(arg))
      ) {
        throw new Error('sandboxed private browser unavailable');
      }
      monitor = await monitorPrivateBrowser(child.pid, (reason) => controller.abort(reason));
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      await page.setBypassServiceWorker(true);
      await page.setRequestInterception(true);
      const origin = `http://materializer-${randomUUID()}.localhost`;
      const entry = `${origin}/worker.js`;
      const bootstrap = `${origin}/bootstrap`;
      let bootstrapServed = false;
      let workerServed = false;
      const intercept = async (request: HTTPRequest) => {
        if (request.method() === 'GET' && request.url() === bootstrap && !bootstrapServed) {
          bootstrapServed = true;
          await request.respond({
            status: 200,
            contentType: 'text/html',
            headers: {
              'Content-Security-Policy': `default-src 'none'; script-src 'none'; worker-src ${entry}; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`,
              'Cache-Control': 'no-store',
            },
            body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Private materializer</title>',
          });
        } else if (request.method() === 'GET' && request.url() === entry && !workerServed) {
          workerServed = true;
          await request.respond({
            status: 200,
            contentType: 'text/javascript',
            headers: {
              'Content-Security-Policy': WORKER_POLICY,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
            body: options.module,
          });
        } else {
          externalRequests++;
          await request.abort('blockedbyclient');
          throw new Error(
            `materializer attempted an undeclared ${request.resourceType()} request: ${request.url().slice(0, 200)}`,
          );
        }
      };
      page.on('request', (request) => {
        void intercept(request).catch((error) => controller.abort(error));
      });
      await page.goto(bootstrap, { waitUntil: 'domcontentloaded' });
      const value = await page.evaluate(runBrowserWorker, entry, options.requestJson, WIRE_BUDGET);
      controller.signal.throwIfAborted();
      if (Buffer.byteLength(value) > WIRE_BUDGET) throw new Error('materializer output budget exceeded');
      return value;
    };
    execution = execute();
    json = await Promise.race([execution, aborted]);
    completed = true;
  } finally {
    if (!completed) controller.abort(new Error('materializer aborted'));
    await execution?.catch(() => undefined);
    clearTimeout(deadline);
    options.signal.removeEventListener('abort', revoke);
    controller.signal.removeEventListener('abort', onAbort);
    await monitor?.stop();
    try {
      monitor?.kill();
    } finally {
      await browser?.close().catch(() => undefined);
      try {
        await monitor?.assertDisposed();
      } finally {
        if (profile) await rm(profile, { recursive: true, force: true });
      }
    }
  }
  options.signal.throwIfAborted();
  if (!monitor) throw new Error('materializer resource monitor unavailable');
  return {
    json,
    metrics: { ...monitor.metrics(), durationMs: performance.now() - started, disposed: true, externalRequests },
  };
}
