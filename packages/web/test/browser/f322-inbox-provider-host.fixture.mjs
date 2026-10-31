import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxConversationFixture } from './f322-inbox-conversation.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
export async function openProviderHost({ t, language, width, evidence }) {
  const f = await createInboxConversationFixture(language);
  let env, server, browser, page;
  const errors = [],
    posts = [],
    results = [],
    entries = [];
  t.after(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
        await writeFile(
          path.join(evidence, 'final-state.json'),
          JSON.stringify(
            {
              text: await page.locator('body').innerText(),
              posts,
              errors,
              results,
              canonical: await Promise.all(entries.map((entry) => f.store.get(entry.pending.request.interactionId))),
              mutations: f.mutations,
              queue: f.queue.list(f.conversationThread.id, 'default-user'),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      try {
        if (browser) await browser.close();
      } finally {
        try {
          if (server) await stopChild(server);
        } finally {
          await Promise.all([env?.cleanup(), f.close()]);
        }
      }
    }
  });
  for (const surface of ['chat', 'inbox'])
    for (const kind of ['approval', 'question', 'form', 'url']) {
      const entry = await f.createProvider(`${surface}-${kind}`, kind);
      assert.equal(entry.pending.request.entrustedWorkTaskRef, undefined, 'An unlinked form must remain actionable');
      entries.push({ surface, kind, ...entry });
    }
  const port = await availablePort();
  env = await createNextDevTestEnvironment(`f322-provider-${language}-${width}`, {
    API_SERVER_PORT: String(f.apiPort),
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${f.apiPort}`,
    FRONTEND_PORT: String(port),
  });
  server = spawn(
    process.execPath,
    [
      path.join(web, 'scripts/sync-vendor-assets.mjs'),
      '--watch',
      '--',
      process.execPath,
      path.join(tree, 'node_modules/next/dist/bin/next'),
      'dev',
      '-H',
      '127.0.0.1',
      '-p',
      String(port),
    ],
    { cwd: web, env: env.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/thread/${f.conversationThread.id}`, server);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/runtime-interactions\/[^/]+\/(respond|reject)$/.test(new URL(request.url()).pathname)
    )
      posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.addInitScript((language) => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', language);
    localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
  }, language);
  return { f, entries, page, errors, posts, results, base };
}
