import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createNextReviewFixture } from './f322-inbox-review-next.fixture.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');

/** Same F309 owner and writers in the actual Next shell; original workspace return and cold result. */
export async function verifyNextReview({ t, language, width, evidenceRoot }) {
  const root = await mkdtemp(path.join(tmpdir(), 'f322-review-next-'));
  const evidence = path.join(evidenceRoot, 'next', `${language}-${width}`);
  await mkdir(evidence, { recursive: true });
  let f, env, server, browser, page;
  const errors = [],
    writes = [],
    reads = [];
  t.after(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
        await writeFile(
          path.join(evidence, 'final-state.json'),
          JSON.stringify({ text: await page.locator('body').innerText(), errors, writes, reads }, null, 2),
        );
      }
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          if (server) await stopChild(server);
        } finally {
          try {
            await Promise.all([env?.cleanup(), f?.close()]);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    }
  });
  await mediaFixture(root, 'png');
  f = await createNextReviewFixture(root);
  const prepared = await f.prepare();
  const port = await availablePort();
  env = await createNextDevTestEnvironment(`f322-review-next-${language}-${width}`, {
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
  await waitForHttp(`${base}/thread/${f.review.thread.id}`, server);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/artifact-reviews\/[^/]+\/actions$/.test(pathname))
      writes.push(request.postDataJSON());
    if (request.method() === 'GET' && /\/artifact-reviews\/[^/]+$/.test(pathname)) reads.push(pathname);
  });
  await page.addInitScript((language) => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', language);
    localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
  }, language);
  await page.goto(`${base}/thread/${f.review.thread.id}?shell=v2`);
  const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
  const unsent = `Unsent original chat draft · ${language} ${width}`;
  await composer.fill(unsent);
  await page.getByTestId('mailbox-button').click();
  const card = page.getByTestId('mailbox-review-card');
  const label =
    language === 'en'
      ? {
          field: 'Review decision explanation',
          approve: 'Approve this version',
          changes: 'Request changes',
          preview: 'View artwork',
          outcome: width === 390 ? 'Changes requested' : 'Version approved',
        }
      : {
          field: '审阅结论说明',
          approve: '通过此版本',
          changes: '要求修改',
          preview: '查看作品',
          outcome: width === 390 ? '需要修改' : '这版通过',
        };
  const field = card.getByRole('textbox', { name: label.field });
  await field.waitFor();
  const row = page.getByTestId('mailbox-item').filter({ has: card });
  assert.equal(await row.getAttribute('data-expanded'), 'false');
  const read = f.reads.at(-1);
  assert.equal(read.identity.ownerUserId, 'operator');
  assert.equal(read.status, 'available');
  assert.equal(read.consistency.state, 'verified');
  assert.equal(read.sources.needsMe.status, 'available');
  assert.equal(read.sources.needsMe.exhaustiveness, 'complete');
  assert.equal(read.sources.approvals.status, 'available');
  assert.equal(read.sources.collectiveAccountabilityRequests.status, 'available');
  assert.equal(read.sources.collectiveAccountabilityRequests.exhaustiveness, 'complete');
  const item = read.items.find((item) => item.decisionRef === `f309.content_review:${prepared.reviewId}`);
  assert.ok(item);
  await card.locator('summary').filter({ hasText: label.preview }).click();
  await card.getByRole('img', { name: label.preview }).waitFor();
  const explanation = `Persistent original F309 decision · ${language} ${width}`;
  await field.fill(explanation);
  const draftPrefix = `cat-cafe:review:operator:${prepared.reviewId}:`;
  const draftKey = `${draftPrefix}round:1:decision`;
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).body, draftKey), explanation);
  await card.screenshot({ path: path.join(evidence, 'inbox-preview-draft.png') });
  const origin = row.getByTestId('mailbox-open-original');
  assert.equal(await origin.getAttribute('data-place'), 'exact');
  await origin.click();
  const original = page.getByTestId('artifact-review-surface');
  await original.waitFor();
  await original.getByText(explanation, { exact: false }).waitFor();
  assert.ok(reads.includes(`/api/artifact-reviews/${prepared.reviewId}`));
  await original.screenshot({ path: path.join(evidence, 'exact-original-with-draft.png') });
  await page.reload();
  await original.getByText(explanation, { exact: false }).waitFor();
  assert.equal(await composer.inputValue(), unsent);
  await page.getByTestId('mailbox-button').click();
  await field.waitFor();
  assert.equal(await field.inputValue(), explanation);
  const before = await f.review.reviews.read(prepared.reviewId, f.review.human);
  const outcome = width === 390 ? 'changes_requested' : 'approved';
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/artifact-reviews/${prepared.reviewId}/actions`),
  );
  await card.getByRole('button', { name: outcome === 'approved' ? label.approve : label.changes, exact: true }).click();
  const response = await posted;
  assert.equal(response.status(), 200);
  const body = await response.json();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].action, { kind: 'decide', outcome, explanation });
  assert.equal(writes[0].expectedRevision, before.review.revision);
  assert.equal(writes[0].expectedTaskRevision, before.authority.taskRevision);
  const decision = body.view.review.rounds[0].decision;
  assert.equal(decision.outcome, outcome);
  assert.equal(decision.explanation, explanation);
  assert.ok(decision.receiptRef);
  assert.deepEqual(decision.actor, f.review.human.actor);
  // A network response observed by the driver precedes the browser owner's acknowledgement.
  // Reload only after that owner has settled its exact retry record and committed draft.
  await page.waitForFunction(
    ({ draftKey, pendingKey }) => localStorage.getItem(draftKey) === null && localStorage.getItem(pendingKey) === null,
    { draftKey, pendingKey: `${draftPrefix}pending` },
  );
  await page.reload();
  await original.getByText(explanation, { exact: true }).waitFor();
  await original.getByText(label.outcome, { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), unsent);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), draftKey), null);
  await page.getByTestId('mailbox-button').click();
  await row.waitFor({ state: 'detached' });
  const panel = page.getByTestId('mailbox-panel');
  const panelState = (element) => ({
    opacity: getComputedStyle(element).opacity,
    background: getComputedStyle(element).backgroundColor,
    shell: document.documentElement.dataset.shell,
    animations: element.getAnimations().map((animation) => ({
      state: animation.playState,
      currentTime: animation.currentTime,
      duration: animation.effect.getTiming().duration,
    })),
  });
  const framing = { before: await panel.evaluate(panelState) };
  // A retired row is already absent while the newly reopened panel is still fading in.
  // Capture the normal completed transition, preserving its real styles and timing.
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="mailbox-panel"]');
    return (
      panel &&
      getComputedStyle(panel).opacity === '1' &&
      panel.getAnimations().every((animation) => animation.playState === 'finished')
    );
  });
  framing.after = await panel.evaluate(panelState);
  assert.notEqual(framing.after.background, 'rgba(0, 0, 0, 0)');
  const after = await f.review.reviews.read(prepared.reviewId, f.review.human);
  assert.equal(after.review.rounds[0].decision.explanation, explanation);
  assert.equal((await f.review.tasks.get(f.review.taskId)).status, 'doing');
  assert.equal(f.mutations.filter((mutation) => mutation.path.endsWith('/messages')).length, 0);
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.ok(Math.max(geometry.body, geometry.document) <= width + 1);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        language,
        width,
        read,
        before,
        after,
        writes,
        history: f.review.store.history(prepared.reviewId),
        geometry,
        framing,
        errors,
        source: item,
        boundary:
          'Actual Next shell/Inbox/F307 original workspace, original private F309 Task/media/ledger/HTTP CAS and cold original result. Controlled provider Queue fixture; no live provider, Alpha or runtime result.',
      },
      null,
      2,
    ),
  );
}
