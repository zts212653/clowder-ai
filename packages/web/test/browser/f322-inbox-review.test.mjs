import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

// API source uses emitted .js specifiers; native Node type stripping does not resolve them to .ts.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const { projectCompanionDecisions } = await tsImport(
  path.join(repoRoot, 'packages/api/src/routes/companion-decision-projection.ts'),
  import.meta.url,
);
const { decisionQualified } = await tsImport(
  path.join(repoRoot, 'packages/api/src/routes/companion-decision-qualification.ts'),
  import.meta.url,
);
const { startReviewHost } = await tsImport(
  path.join(repoRoot, 'packages/web/test/browser/fixtures/f309-artifact-review-host.mjs'),
  import.meta.url,
);

const entryPath = fileURLToPath(new URL('./fixtures/f322-inbox-review-host.tsx', import.meta.url));
const evidenceRoot = process.env.F322_INBOX_REVIEW_EVIDENCE ?? path.join(tmpdir(), `f322-inbox-review-${process.pid}`);
for (const language of ['zh', 'en'])
  for (const width of [1440, 390]) {
    test(`F322 original review card ${language} ${width}`, { timeout: 180000 }, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'f322-inbox-review-'));
      const evidence = path.join(evidenceRoot, `${language}-${width}`);
      await mkdir(evidence, { recursive: true });
      let host, browser, page;
      const writes = [],
        errors = [];
      t.after(async () => {
        if (page && !page.isClosed()) {
          await page.screenshot({ path: path.join(evidence, 'final.png') });
          await writeFile(
            path.join(evidence, 'page.json'),
            JSON.stringify({ text: await page.locator('body').innerText(), errors }, null, 2),
          );
        }
        await browser?.close();
        await host?.close();
        await rm(root, { recursive: true, force: true });
      });
      await mediaFixture(root, 'png');
      host = await startReviewHost(root, 'image/png', { entryPath });
      await host.taskCallback('update-entrusted-work', {
        taskId: host.taskId,
        expectedRevision: 1,
        status: 'doing',
      });
      const taskBefore = await host.tasks.get(host.taskId);
      assert.equal(taskBefore.status, 'doing');
      const taskRevision = taskBefore.entrustedWork.revision;
      assert.equal(taskRevision, 2);
      const prepared = await host.catCallback('prepare', {
        ...host.prepare,
        expectedTaskRevision: taskRevision,
      });
      await host.catCallback('act', {
        reviewId: prepared.reviewId,
        expectedRevision: prepared.revision,
        expectedTaskRevision: taskRevision,
        operationId: `inbox-request-${language}-${width}`,
        round: 1,
        action: { kind: 'request_judgment', summary: '核对封面标题', judgmentNeeded: '这版标题能否继续发布？' },
      });
      const ownerResponse = await fetch(`${host.apiOrigin}/api/entrusted-work/needs-me`);
      assert.equal(ownerResponse.status, 200);
      const ownerSource = await ownerResponse.json();
      const now = Date.now();
      const source = (coverage) => ({
        status: 'available',
        exhaustiveness: 'complete',
        startedAt: now,
        observedAt: now,
        coverage,
      });
      const read = projectCompanionDecisions(
        { items: [], coverage: { state: 'complete' } },
        ownerSource,
        'operator',
        { offset: 0, limit: 20 },
        now,
        { approvals: source('all_registered_F246_producers'), needsMe: source('current_linked_F310_five_producers') },
      );
      assert.equal(read.items.length, 1);
      assert.equal(read.totalCount, 1, 'The controlled original source projects one review row');
      assert.equal(read.attentionCount, undefined, 'This bounded host does not supply an all-kind F306 source');
      const item = read.items[0];
      assert.equal(decisionQualified(item), true, 'The original named F309 receipt qualifies as a decision');
      assert.equal(item.decisionRef, `f309.content_review:${prepared.reviewId}`);
      const before = await host.reviews.read(prepared.reviewId, host.human);
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/artifact-reviews\/[^/]+\/actions$/.test(new URL(request.url()).pathname)
        ) {
          writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
        }
      });
      await page.addInitScript(
        ({ language, read }) => {
          window.__F322_REVIEW_READ__ = read;
          localStorage.setItem('cat-cafe:shell-presentation', 'v2');
          localStorage.setItem('cat-cafe:shell-language', language);
          localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
        },
        { language, read },
      );
      await page.goto(host.origin);
      const card = page.getByTestId('mailbox-review-card');
      const label =
        language === 'en'
          ? {
              field: 'Review decision explanation',
              approve: 'Approve this version',
              changes: 'Request changes',
              preview: 'View artwork',
            }
          : { field: '审阅结论说明', approve: '通过此版本', changes: '要求修改', preview: '查看作品' };
      const field = card.getByRole('textbox', { name: label.field });
      await field.waitFor();
      await page.screenshot({ path: path.join(evidence, 'closed.png') });
      await card.locator('summary').filter({ hasText: label.preview }).focus();
      await page.keyboard.press('Enter');
      await card.getByRole('img', { name: label.preview }).waitFor();
      await page.screenshot({ path: path.join(evidence, 'preview.png') });
      const explanation = `Keep the original persistent review explanation · ${language} ${width}`;
      await field.fill(explanation);
      const draftKey = `cat-cafe:review:operator:${prepared.reviewId}:round:1:decision`;
      const draft = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), draftKey);
      assert.equal(draft.body, explanation);
      await page.reload();
      await field.waitFor();
      assert.equal(await field.inputValue(), explanation, 'Reload restores the original key');
      const outcome = width === 390 ? 'changes_requested' : 'approved';
      await card
        .getByRole('button', { name: outcome === 'approved' ? label.approve : label.changes, exact: true })
        .focus();
      await page.keyboard.press('Enter');
      const result = page.getByTestId('mailbox-review-result');
      await result.waitFor();
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].body.action, { kind: 'decide', outcome, explanation });
      assert.equal(writes[0].body.expectedRevision, before.review.revision);
      assert.equal(writes[0].body.expectedTaskRevision, before.authority.taskRevision);
      const after = await host.reviews.read(prepared.reviewId, host.human);
      const decision = after.review.rounds[0].decision;
      assert.equal(decision.outcome, outcome);
      assert.equal(decision.explanation, explanation);
      assert.deepEqual(decision.actor, host.human.actor);
      assert.ok(decision.receiptRef);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), draftKey), null);
      assert.equal((await host.tasks.get(host.taskId)).status, 'doing', 'A review decision is not Task completion');
      const remaining = await (await fetch(`${host.apiOrigin}/api/entrusted-work/needs-me`)).json();
      assert.equal(remaining.ownerReads.length, 0);
      const geometry = await result.evaluate((node) => ({
        text: node.textContent,
        right: node.getBoundingClientRect().right,
        viewport: innerWidth,
      }));
      assert.ok(geometry.right <= geometry.viewport);
      assert.ok(!geometry.text.includes('operator') && !geometry.text.includes('default-user'));
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
            draft,
            geometry,
            taskStatus: 'doing',
            remainingNeedsMe: remaining,
            history: host.store.history(prepared.reviewId),
            boundary:
              'Mounted production MailboxRow, original private journal/media/owner GET and CAS routes, original queue fixture. Not full Next shell, global result retention, provider execution, Alpha or whole-17 acceptance.',
          },
          null,
          2,
        ),
      );
    });
  }

for (const language of ['zh', 'en'])
  for (const width of [1440, 390])
    test(`F322 actual Next review and exact original result ${language} ${width}`, { timeout: 180000 }, async (t) => {
      const { verifyNextReview } = await tsImport(
        path.join(repoRoot, 'packages/web/test/browser/f322-inbox-review-next.journey.mjs'),
        import.meta.url,
      );
      await verifyNextReview({ t, language, width, evidenceRoot });
    });
