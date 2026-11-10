/**
 * F333: the shared browser process, forked by the API (see BrowserProcess.ts).
 *
 * Lifetime: exits when the API's IPC channel closes, after 15 idle minutes with no session and no
 * running browser, and right after a call outlives its deadline (the late call cannot be cancelled,
 * so it ends with this process; Sol5.6 R3). The API forks a fresh one on the next request. Every exit
 * closes Chrome within CLOSE_BOUND_MS, so the next process can take the profile. It never retries a
 * tool call.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import playwrightMcp from '@playwright/mcp';
import { BrowserSessionHost, type McpServerLike } from './browser-session-host.js';
import { workspaceProfileDir } from './shared-browser-descriptor.js';
import type { PoolContext } from './shared-browser-pool.js';

const IDLE_EXIT_MS = 15 * 60_000;
const REAP_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A graceful close keeps logins on disk; past this, exit anyway (Playwright kills Chrome on exit). */
const CLOSE_BOUND_MS = 5_000;

// The exact Playwright build @playwright/mcp was released against, not another copy in the tree.
const { chromium } = createRequire(import.meta.resolve('@playwright/mcp/package.json'))('playwright') as {
  chromium: {
    launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<PoolContext>;
  };
};

function launch(workspace: string): Promise<PoolContext> {
  return chromium.launchPersistentContext(workspaceProfileDir(workspace), {
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // Upstream keeps extensions enabled in persistent profiles; match it so logins behave the same.
    ignoreDefaultArgs: ['--disable-extensions'],
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function start(key: string, requestDeadlineMs: number | undefined): void {
  let exiting = false;
  // Every exit (IPC gone, idle, or a call past its deadline) stops serving first and tells the API,
  // so new requests wait for the next process instead of reaching this one while it closes.
  const exitAfterClosing = () => {
    if (exiting) return;
    exiting = true;
    host.stopServing();
    if (process.connected) process.send?.({ type: 'retiring' });
    const bound = new Promise((resolve) => setTimeout(resolve, CLOSE_BOUND_MS));
    void Promise.race([host.closeAll().catch(() => {}), bound]).finally(() => process.exit(0));
  };
  const host = new BrowserSessionHost({
    key,
    launch,
    requestDeadlineMs,
    createServer: (config, getter) =>
      playwrightMcp.createConnection(config as never, getter as never) as unknown as Promise<McpServerLike>,
    onPoisoned: () => exitAfterClosing(),
  });
  let idleSince = Date.now();
  const server = createServer((req, res) => {
    const body = req.method === 'POST' ? readJson(req) : Promise.resolve(undefined);
    body
      .then((parsed) => host.handle(req, res, parsed))
      .catch(() => {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
      });
  });
  process.on('disconnect', exitAfterClosing);
  // The API's watchdog kills this process when these stop (a blocked event loop stops them too).
  setInterval(() => process.send?.({ type: 'heartbeat' }), HEARTBEAT_MS).unref();
  setInterval(() => {
    void host.reap().then(() => {
      if (host.sessionCount > 0 || host.browserCount > 0) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_EXIT_MS) exitAfterClosing();
    });
  }, REAP_INTERVAL_MS).unref();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') process.send?.({ type: 'ready', port: address.port });
  });
}

process.once('message', (message: unknown) => {
  const init = (message ?? {}) as { type?: string; key?: unknown; requestDeadlineMs?: unknown };
  const deadline =
    typeof init.requestDeadlineMs === 'number' && init.requestDeadlineMs > 0 ? init.requestDeadlineMs : undefined;
  if (init.type === 'init' && typeof init.key === 'string' && init.key.length >= 32) start(init.key, deadline);
  else process.exit(1);
});
