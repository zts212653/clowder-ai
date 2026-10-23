import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createInboxInformationFixture } from './f322-inbox-information.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const prefix = { F193: 'dispatch', F221: 'taste', F260: 'entity' };
async function press(page, card, record, verb, responses) {
  const button = card.getByTestId(verb === 'approve' ? 'approve-btn' : 'reject-btn');
  await button.waitFor();
  await page.waitForFunction((el) => !el.disabled, await button.elementHandle());
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/${prefix[record.kind]}-proposals/${record.proposalId}/${verb}` &&
      r.request().method() === 'POST',
  );
  await button.focus();
  await page.keyboard.press('Enter');
  const result = await response;
  responses.push({ path: new URL(result.url()).pathname, status: result.status(), body: await result.json() });
  assert.equal(result.status(), 200);
}
async function freeze(page, card) {
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function readStates(source) {
  return Promise.all(
    source.records.map(async (r) => ({
      kind: r.kind,
      verb: r.verb,
      proposal: await (r.kind === 'F193' ? source.dispatch : r.kind === 'F221' ? source.taste : source.entity).get(
        r.proposalId,
      ),
    })),
  );
}
export function registerInformationJourneys(evidenceRoot) {
  for (const language of ['zh', 'en'])
    for (const width of [1440, 390])
      test(`F322 original information Chat and Inbox ${language} ${width}`, { timeout: 240000 }, async (t) => {
        const evidence = path.join(evidenceRoot, 'information', `${language}-${width}`);
        await mkdir(evidence, { recursive: true });
        const f = await createInboxInformationFixture(language),
          source = f.approvalSources;
        const chatRecords = source.records.filter((r) => r.verb === 'reject'),
          inboxRecords = source.records.filter((r) => r.verb === 'approve');
        let env, server, browser, page;
        const errors = [],
          decisions = [],
          responses = [],
          render = [];
        t.after(async () => {
          try {
            if (page && !page.isClosed()) {
              await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true });
              await writeFile(
                path.join(evidence, 'final-state.json'),
                JSON.stringify(
                  {
                    text: await page.locator('body').innerText(),
                    errors,
                    decisions,
                    responses,
                    mutations: f.mutations,
                    reads: f.reads,
                    states: await readStates(source),
                    effects: await source.effects(),
                  },
                  null,
                  2,
                ),
              );
            }
          } finally {
            const results = await Promise.allSettled([
              browser?.close(),
              server ? stopChild(server) : undefined,
              env?.cleanup(),
              f.close(),
            ]);
            const failures = results.filter((r) => r.status === 'rejected');
            if (failures.length)
              throw new AggregateError(
                failures.map((r) => r.reason),
                'Owned information journey cleanup failed',
              );
          }
        });
        const port = await availablePort();
        env = await createNextDevTestEnvironment(`f322-information-${language}-${width}`, {
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
        await waitForHttp(`${base}/thread/${chatRecords[0].thread.id}`, server);
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage({ viewport: { width, height: 1000 } });
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
          if (
            request.method() === 'POST' &&
            /^\/api\/(dispatch|taste|entity)-proposals\/[^/]+\/(approve|reject|resolve)$/.test(
              new URL(request.url()).pathname,
            )
          )
            decisions.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
        });
        await page.addInitScript((lang) => {
          localStorage.setItem('cat-cafe:shell-presentation', 'v2');
          localStorage.setItem('cat-cafe:shell-language', lang);
        }, language);
        await page.goto(`${base}/thread/${chatRecords[0].thread.id}?shell=v2`);
        for (const record of chatRecords) {
          const card = page.locator(`[data-rich-block-id="${record.block.id}"]`);
          await card.getByTestId('reject-btn').waitFor();
          await freeze(page, card);
          const before = await card.innerText();
          assert.ok(!before.includes('default-user') && !before.includes(record.proposalId));
          render.push({ entrance: 'Chat', kind: record.kind, before, box: await card.boundingBox() });
          await page.screenshot({ path: path.join(evidence, `chat-${record.kind}-before.png`), fullPage: true });
          await press(page, card, record, 'reject', responses);
          await card.getByTestId('decision-result-label').waitFor();
          await freeze(page, card);
          await page.screenshot({ path: path.join(evidence, `chat-${record.kind}-collapsed.png`), fullPage: true });
          await card.locator('button[aria-expanded="false"]').click();
          await card.getByTestId('domain-approval-result').waitFor();
          await freeze(page, card);
          assert.match(
            await card.getByTestId('domain-approval-result').innerText(),
            language === 'en' ? /Rejected.*You/ : /已拒绝.*你/,
          );
          await page.screenshot({ path: path.join(evidence, `chat-${record.kind}-after.png`), fullPage: true });
        }
        const draft = page.locator('[data-testid="chat-input-composer-row"] textarea');
        const draftText = 'Preserved original information-card draft';
        await draft.fill(draftText);
        await page.getByTestId('mailbox-button').click();
        await page.getByTestId('mailbox-panel').waitFor();
        for (const record of inboxRecords) {
          const card = page.getByTestId(`approval-item-${record.proposalId}`);
          await card.waitFor();
          await freeze(page, card);
          const row = card.locator('xpath=ancestor::li');
          assert.equal(await row.getAttribute('data-expanded'), 'false');
          const disclosure = card.locator('details').first();
          assert.equal(await disclosure.getAttribute('open'), null);
          const before = await card.innerText(),
            box = await card.boundingBox();
          const actionGeometry = await card.evaluate((element) => {
            const style = getComputedStyle(element),
              rect = element.getBoundingClientRect();
            const group = element.querySelector('[data-testid="domain-approval-place-actions"]');
            const buttons = group
              ? [...group.querySelectorAll('button')].map((button) => {
                  const box = button.getBoundingClientRect();
                  return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
                })
              : [];
            return {
              contentRight: rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
              group: group?.getBoundingClientRect().toJSON(),
              buttons,
            };
          });
          assert.equal(actionGeometry.buttons.length, 2);
          assert.ok(
            Math.abs(actionGeometry.buttons[0].y - actionGeometry.buttons[1].y) <= 1,
            'Ignore/open share one position',
          );
          assert.ok(
            Math.abs(actionGeometry.contentRight - actionGeometry.group.right) <= 2,
            'Original actions stay at the right',
          );
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
          assert.ok(!before.includes('default-user') && !before.includes(record.proposalId));
          render.push({
            entrance: 'Inbox',
            kind: record.kind,
            before,
            box,
            actionGeometry,
            originalLongContentClosed: true,
          });
          await page.screenshot({ path: path.join(evidence, `inbox-${record.kind}-closed.png`), fullPage: true });
          await disclosure.locator('summary').focus();
          await page.keyboard.press('Enter');
          const section = disclosure.locator('section');
          assert.equal(await section.isVisible(), true);
          assert.ok((await section.boundingBox()).height <= 257);
          await section.focus();
          await page.keyboard.press('End');
          await page.screenshot({ path: path.join(evidence, `inbox-${record.kind}-open.png`), fullPage: true });
          await press(page, card, record, 'approve', responses);
          const effect =
            record.kind === 'F193'
              ? language === 'en'
                ? 'Original message delivered'
                : '原消息已送达'
              : record.kind === 'F221'
                ? language === 'en'
                  ? 'Taste written'
                  : '品味已写入'
                : language === 'en'
                  ? 'Entity written'
                  : '实体已写入';
          const result = page.getByTestId('mailbox-retained-line').filter({ hasText: effect });
          await result.waitFor();
          await freeze(page, result);
          await page.screenshot({ path: path.join(evidence, `inbox-${record.kind}-result.png`), fullPage: true });
        }
        const states = await readStates(source);
        assert.ok(states.every((s) => s.proposal.status === (s.verb === 'reject' ? 'rejected' : 'approved')));
        const effects = await source.effects();
        assert.equal(effects.deliveries.length, 1);
        assert.equal(effects.targetMessages.length, 1);
        assert.equal(effects.vignettes.length, 1);
        assert.ok(effects.vignettes[0].content.includes('Keep the original evidence'));
        assert.ok(effects.entities[0]);
        assert.equal(effects.entities[1], null);
        assert.equal(decisions.length, 6);
        assert.equal(f.mutations.filter((m) => /^\/api\/(dispatch|taste|entity)-proposals\//.test(m.path)).length, 6);
        const resultText = await page.getByTestId('mailbox-retained-line').allTextContents();
        assert.ok(resultText.every((text) => !text.includes('default-user') && !text.includes('information-')));
        const resultCards = await page.getByTestId('mailbox-retained-result').allTextContents();
        assert.ok(resultCards.every((text) => !text.includes('cognitive-honesty') && !text.includes('(concept)')));
        for (const kind of language === 'en' ? ['Work assignment', 'Taste', 'Entity'] : ['派活', '品味', '实体'])
          assert.ok(resultCards.some((text) => text.includes(kind)));
        await page.getByTestId('mailbox-close').click();
        assert.equal(await draft.inputValue(), draftText);
        const [superseded] = await source.createSuperseded(chatRecords[0].thread);
        await page.reload();
        for (const record of chatRecords) {
          const card = page.locator(`[data-rich-block-id="${record.block.id}"]`);
          await card.getByTestId('decision-result-label').waitFor();
          await card.locator('button[aria-expanded="false"]').click();
          await card.getByTestId('domain-approval-result').waitFor();
        }
        await page.screenshot({ path: path.join(evidence, 'chat-cold-results.png'), fullPage: true });
        const oldChat = page.locator(`[data-rich-block-id="${superseded.block.id}"]`);
        await oldChat.getByTestId('decision-result-label').waitFor();
        assert.equal(await oldChat.getByTestId('decision-result-dot').getAttribute('data-status'), 'closed');
        assert.equal(
          await oldChat.locator('form, input, [data-testid="approve-btn"], [data-testid="reject-btn"]').count(),
          0,
        );
        await oldChat.screenshot({ path: path.join(evidence, 'F193-superseded-chat-cold.png') });
        await page.getByTestId('mailbox-button').click();
        await page.getByTestId('approval-item-inbox-native-approve').waitFor();
        assert.equal(await page.locator('[data-testid^="approval-item-information-"]').count(), 0);
        const oldInbox = page.locator(
          `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify(['F193', superseded.proposalId])}']`,
        );
        await oldInbox.getByTestId('decision-result-label').waitFor();
        assert.equal(await oldInbox.getByTestId('decision-result-dot').getAttribute('data-status'), 'closed');
        await oldInbox.locator('button[aria-expanded="false"]').click();
        assert.match(await oldInbox.innerText(), /This assignment was replaced by a newer request/);
        assert.equal(
          await oldInbox.locator('form, input, [data-testid="approve-btn"], [data-testid="reject-btn"]').count(),
          0,
        );
        await oldInbox.screenshot({ path: path.join(evidence, 'F193-superseded-inbox-cold.png') });
        const coldEffects = [];
        await page.getByTestId('mailbox-close').click();
        for (const verb of ['approve', 'unknown']) {
          const records = source.records.filter((r) => r.verb === verb && ['F193', 'F260'].includes(r.kind));
          await page.goto(`${base}/thread/${records[0].thread.id}?shell=v2`);
          for (const record of records) {
            const card = page.locator(`[data-rich-block-id="${record.block.id}"]`);
            const expected =
              verb === 'unknown'
                ? language === 'en'
                  ? 'Effect not yet confirmed'
                  : '效果暂未确认'
                : record.kind === 'F193'
                  ? language === 'en'
                    ? 'Original message delivered'
                    : '原消息已送达'
                  : language === 'en'
                    ? 'Entity written'
                    : '实体已写入';
            await card.getByTestId('decision-result-label').filter({ hasText: expected }).waitFor();
            await freeze(page, card);
            await card.screenshot({ path: path.join(evidence, `${record.kind}-${verb}-chat-cold.png`) });
            coldEffects.push({ entrance: 'Chat', kind: record.kind, verb, text: await card.innerText() });
            await card.locator('button[aria-expanded="false"]').click();
            assert.equal(
              await card.locator('[data-testid="approve-btn"], [data-testid="reject-btn"], form, input').count(),
              0,
            );
          }
          await page.getByTestId('mailbox-button').click();
          for (const record of records) {
            const row = page.locator(
              `[data-testid="mailbox-settled-result"][data-decision-key='${JSON.stringify([record.kind, record.proposalId])}']`,
            );
            const expected =
              verb === 'unknown'
                ? language === 'en'
                  ? 'Effect not yet confirmed'
                  : '效果暂未确认'
                : record.kind === 'F193'
                  ? language === 'en'
                    ? 'Original message delivered'
                    : '原消息已送达'
                  : language === 'en'
                    ? 'Entity written'
                    : '实体已写入';
            await row.getByTestId('decision-result-label').filter({ hasText: expected }).waitFor();
            await freeze(page, row);
            await row.screenshot({ path: path.join(evidence, `${record.kind}-${verb}-inbox-cold.png`) });
            coldEffects.push({ entrance: 'Inbox', kind: record.kind, verb, text: await row.innerText() });
            await row.locator('button[aria-expanded="false"]').click();
            assert.equal(
              await row.locator('[data-testid="approve-btn"], [data-testid="reject-btn"], form, input').count(),
              0,
            );
          }
          await page.getByTestId('mailbox-close').click();
        }
        assert.equal(
          f.mutations.filter((m) => /^\/api\/(dispatch|taste|entity)-proposals\//.test(m.path)).length,
          6,
          'cold reads never restore writers',
        );
        assert.deepEqual(errors, []);
        await writeFile(
          path.join(evidence, 'proof.json'),
          JSON.stringify(
            {
              language,
              width,
              render,
              decisions,
              responses,
              coldEffects,
              resultText,
              resultCards,
              states,
              effects,
              supersededState: await source.dispatch.get(superseded.proposalId),
              mutations: f.mutations,
              reads: f.reads,
              errors,
              draftPreserved: true,
              boundary:
                'Real Next/Chat/Inbox, actual staged stores/builders/Ingress/owner routes/Hub proof/settled read. F193 legacy shadow route writes these private Messages; no modern action-lease admission or provider dispatch claim. Taste writer is bounded to mkdtemp and reread; entity uses actual private SQLite registry. No production store, Redis, Alpha/runtime, or whole17 acceptance.',
            },
            null,
            2,
          ),
        );
      });
}
