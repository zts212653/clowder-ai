import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collapseV2Workspace } from './f307-workspace-open.mjs';
import { createDocumentRequest } from './f309-ordinary-document-request.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';

/** Real file/Task/callback/CAS/history; session, source message and same-turn provider causal cut are declared fixtures. */
export function registerDocumentReopenJourney(suite) {
  for (const [slug, width, dark] of [
    ['v2-desktop-light', 1440, false],
    ['v2-390-dark', 390, true],
  ]) {
    test(
      `document owner: v2 cold and existing comparison retain original Human execution (${slug})`,
      { timeout: 150_000 },
      async () => {
        await mkdir(EVIDENCE, { recursive: true });
        const f = await createDocumentRequest({ executionSource: 'original-human' });
        let session;
        const observations = [];
        try {
          session = await openDocumentSession(suite, f.owner, { width, dark, shell: 'v2' });
          const sourceProgress = session.page
            .locator(`[data-message-id="${f.message.id}"]`)
            .getByTestId('modification-progress');
          await sourceProgress.locator('[data-indicator="spinner"]').waitFor({ state: 'visible' });
          assert.equal(await sourceProgress.getAttribute('data-state'), 'working');
          await session.page.screenshot({ path: `${EVIDENCE}/document-reopen-${slug}-working.png` });
          const initial = await f.owner.integration.requests.read(f.record.requestId, f.owner.human);
          assert.equal(initial.execution.state, 'running');
          const child = f.owner.driver.turns.get(initial.execution.invocationId);
          assert.deepEqual(child.causal.coveredMessageIds, [f.message.id]);
          assert.notEqual(
            initial.execution.messageId,
            f.message.id,
            'queue carrier and original Human remain distinct',
          );
          const { returned, receipt } = await f.returnCandidate();
          f.owner.driver.turns.transitionTerminal(child.invocationId, { status: 'succeeded', endedAt: Date.now() });

          const openComparison = async (label) => {
            const { page } = session;
            if (width < 768 && (await page.getByTestId('contextual-workspace-host').isVisible())) {
              await collapseV2Workspace(page);
            }
            await page
              .locator(`[data-message-id="${receipt.id}"]`)
              .getByRole('button', { name: '打开对照', exact: true })
              .click();
            const candidate = page.locator(`[data-candidate-ref="${returned.proposalRef}"]`);
            await candidate.waitFor({ state: 'visible' });
            assert.equal(await page.getByTestId('workspace-content-review-surface').count(), 1);
            assert.equal(
              await page.getByTestId('chat-input-composer-row').count(),
              1,
              'comparison retains the one Chat composer',
            );
            const request = await f.owner.integration.requests.read(f.record.requestId, f.owner.human);
            assert.equal(request.execution.state, 'finished');
            const byMessage = await f.owner.app.inject({
              url: `/api/content-modifications/by-message/${f.message.id}`,
            });
            assert.equal(byMessage.statusCode, 200, byMessage.body);
            assert.equal(byMessage.json().execution.state, 'finished');
            assert.equal(byMessage.json().record.requestId, f.record.requestId);
            assert.doesNotMatch(await page.locator(`[data-message-id="${f.message.id}"]`).innerText(), /无法获取状态/);
            observations.push({
              label,
              url: page.url(),
              candidateRef: returned.proposalRef,
              execution: request.execution,
              calls: session.calls.map(({ method, path, status }) => ({ method, path, status })),
            });
            await page.screenshot({ path: `${EVIDENCE}/document-reopen-${slug}-${label}.png` });
            return candidate;
          };

          // The source context has never opened file annotations; reload preserves the real browser persistence owners.
          await session.page.reload({ waitUntil: 'domcontentloaded' });
          await session.page.locator('[data-chat-container]').waitFor();
          await openComparison('reload-cold');
          // Markdown now keeps its reader and collaboration in the same owner.
          // Visit the real source view before opening the comparison again.
          const viewer = session.page.getByTestId('workspace-file-viewer');
          if (width < 768) await viewer.locator('summary[title="更多文件操作"]').click();
          // The narrow popup is portalled outside the file owner; roles select its visible control.
          await session.page.getByRole('button', { name: '渲染', exact: true }).click();
          await session.page.getByRole('button', { name: '源码', exact: true }).waitFor();
          assert.equal(await session.page.getByTestId('workspace-content-review-surface').count(), 1);
          assert.match(await viewer.innerText(), /# Harbour guide/);
          await session.page.keyboard.press('Escape');
          await openComparison('existing-file');
          await session.context.unrouteAll({ behavior: 'wait' });
          await session.context.close();
          session = await openDocumentSession(suite, f.owner, { width, dark, shell: 'v2' });
          const candidate = await openComparison('new-context');
          await candidate.getByTestId('content-modification-accept').click();
          await candidate.getByText('已写回原文件', { exact: true }).waitFor();
          assert.match(await readFile(f.absolute, 'utf8'), /First revised paragraph/);
          // The parent's post-acceptance case used a genuinely new context, without saved tabs or layout.
          await session.context.unrouteAll({ behavior: 'wait' });
          await session.context.close();
          session = await openDocumentSession(suite, f.owner, { width, dark, shell: 'v2' });
          await openComparison('applied-new-context');
          await session.page
            .getByTestId('workspace-content-review-surface')
            .getByRole('button', { name: '‹ 聊天', exact: true })
            .click();
          assert.ok(session.page.url().includes(`/thread/${f.owner.thread.id}`));
          await session.page.locator(`[data-message-id="${receipt.id}"]`).waitFor({ state: 'visible' });
          assert.equal(
            f.owner.tasks.get(f.taskId).status,
            f.taskStatus,
            'finished invocation and CAS do not complete the Task',
          );
          assert.deepEqual(session.errors, []);
          assert.deepEqual(f.owner.errors, []);
          await writeFile(
            `${EVIDENCE}/document-reopen-${slug}.json`,
            JSON.stringify(
              {
                cwd: process.cwd(),
                testedHead: process.env.F309_TESTED_HEAD,
                observations,
                originalHumanExecution: initial.execution,
                canonicalCausal: child.causal,
                nativeSourceProgress: 'working',
                sourceMessageId: f.message.id,
                requestId: f.record.requestId,
                providerBoundary:
                  'deterministic provider replays recorded original-Human-only canonical causal cut; Human source/session are isolated fixtures; no live model or Alpha claim',
                extraAnnotationClick: false,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          await session?.page.screenshot({ path: `${EVIDENCE}/document-reopen-${slug}-failure.png` }).catch(() => {});
          await writeFile(
            `${EVIDENCE}/document-reopen-${slug}-failure.json`,
            JSON.stringify(
              {
                testedHead: process.env.F309_TESTED_HEAD,
                error: String(error),
                observations,
                url: session?.page.url(),
                errors: session?.errors,
                body: await session?.page
                  .locator('body')
                  .innerText()
                  .catch(() => null),
              },
              null,
              2,
            ),
          );
          throw error;
        } finally {
          await session?.context.close();
          await f.close();
        }
      },
    );
  }
}
