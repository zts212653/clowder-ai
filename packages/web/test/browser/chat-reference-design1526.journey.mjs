import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createChatPathFixture } from './chat-path-links.fixture.mjs';
import { assertGitHubMetadataLines, readGitHubMetadataLines } from './chat-pr-metadata-reading.journey.mjs';
import { closeDesign1526Host, openDesign1526Host } from './chat-reference-design1526-host.fixture.mjs';
import { createInboxConversationFixture } from './f322-inbox-conversation.fixture.mjs';

async function createHistoricalElicitations(fixture, language) {
  const entries = [];
  try {
    for (const kind of ['url', 'form']) {
      const entry = await fixture.createProvider(`design1526-${language}-${kind}`, kind);
      const terminal = await fixture.service.respond({
        interactionId: entry.pending.request.interactionId,
        ownerUserId: entry.pending.request.owner.userId,
        cardRef: entry.pending.cardRef,
        response: { kind: 'decision', decisionId: 'decline' },
      });
      await entry.settled;
      assert.deepEqual(entry.result(), { response: { kind: 'decision', decisionId: 'decline' } });
      entries.push({ kind, ...entry, terminal });
    }
    return entries;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export function registerDesign1526Journeys(root) {
  for (const language of ['zh', 'en'])
    test(`F322 design1526 edge separators and elicitation order ${language}`, { timeout: 240000 }, async (t) => {
      const evidence = path.join(root, 'design1526', language);
      await mkdir(evidence, { recursive: true });
      const hosts = [],
        metadata = [],
        originals = [];
      let completed = false;
      t.after(async () => {
        if (!completed) {
          await writeFile(
            path.join(evidence, 'partial-state.json'),
            JSON.stringify(
              {
                metadata,
                originals,
                errors: hosts.flatMap((host) => host.errors),
                writes: hosts.flatMap((host) => host.writes),
              },
              null,
              2,
            ),
          );
          for (const host of hosts)
            if (!host.closed && host.page && !host.page.isClosed())
              await host.page
                .screenshot({ path: path.join(evidence, `${host.label}-failed.png`), fullPage: true })
                .catch(() => {});
        }
        const cleanup = [];
        for (const host of hosts) {
          try {
            await closeDesign1526Host(host);
            cleanup.push({ status: 'fulfilled', steps: host.cleanup });
          } catch (error) {
            cleanup.push({ status: 'rejected', reason: String(error), steps: host.cleanup });
          }
        }
        await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
        assert.ok(cleanup.every((row) => row.status === 'fulfilled'));
      });
      const paths = await createChatPathFixture(language),
        source = paths.runtime.design;
      const prHost = await openDesign1526Host({
        fixture: paths,
        threadId: source.thread.id,
        language,
        evidence,
        label: 'pr',
      });
      hosts.push(prHost);
      const message = prHost.page.locator(`[data-message-id="${source.message.id}"]`).first();
      const pr = message.locator('[data-chat-reference-kind=github][data-chat-reference-layout=card]');
      await pr.waitFor();
      for (const width of [1440, 390]) {
        await prHost.page.setViewportSize({ width, height: 1100 });
        await pr.scrollIntoViewIfNeeded();
        const groups = await readGitHubMetadataLines(pr);
        await writeFile(path.join(evidence, `pr-${width}-glyphs.json`), JSON.stringify(groups, null, 2));
        assertGitHubMetadataLines(groups);
        const geometry = await pr.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            box: box.toJSON(),
            unobscured: element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.equal(geometry.unobscured, true);
        assert.equal(geometry.overflow, false);
        if (width === 1440) {
          assert.ok(Math.abs(geometry.box.width - 470) <= 1);
          assert.ok(
            Math.abs(geometry.box.height - 110) <= 1,
            'The accepted desktop PR card geometry remains unchanged',
          );
          assert.ok(
            groups.every((group) => group.lines.length === 1),
            'Desktop metadata remains on its original single lines',
          );
        } else {
          assert.ok(
            groups.every((group) => group.lines.length > 1),
            'The accepted narrow PR sample actually exercises both wrapped groups',
          );
          assert.equal(await pr.locator(':focus-visible').count(), 0);
          await pr.screenshot({ path: path.join(evidence, 'pr-390-after.png'), animations: 'disabled' });
        }
        metadata.push({ width, groups, geometry });
      }
      assert.deepEqual(prHost.errors, []);
      assert.deepEqual(prHost.writes, []);
      await closeDesign1526Host(prHost);

      const f = await createInboxConversationFixture(language),
        entries = await createHistoricalElicitations(f, language);
      const providerHost = await openDesign1526Host({
        fixture: f,
        threadId: f.conversationThread.id,
        language,
        evidence,
        label: 'elicitation',
      });
      hosts.push(providerHost);
      for (const width of [1440, 390]) {
        await providerHost.page.setViewportSize({ width, height: 1100 });
        for (const entry of entries) {
          const card = providerHost.page.locator(`[data-message-id="${entry.pending.cardRef.messageId}"]`).first();
          const label = card.getByTestId('decision-result-label');
          await label.waitFor();
          const resultText = await label.innerText();
          assert.match(resultText, language === 'en' ? /Chose “Decline”/ : /已选「拒绝」/);
          await card.locator('button[aria-expanded=false]').first().click();
          const details = card.getByTestId('decision-result-details');
          await details.waitFor();
          await details.getByText(entry.pending.request.message, { exact: true }).waitFor();
          const order = await details.evaluate((element, kind) => {
            const choices = element.querySelector('[data-testid="readonly-choice-list"]');
            const target =
              kind === 'form'
                ? element.querySelector('dl')
                : [...element.querySelectorAll('p')].find((p) => p.textContent === 'https://example.invalid/authorize');
            const paragraphs = [...element.querySelectorAll('p')];
            return {
              text: element.textContent,
              paragraphs: paragraphs.map((p) => ({
                text: p.textContent,
                beforeChoices: !!(p.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING),
              })),
              targetBeforeChoices: !!(target.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING),
              selected: choices.querySelector('[data-selected=true]')?.textContent,
            };
          }, entry.kind);
          await writeFile(
            path.join(evidence, `elicitation-${entry.kind}-${width}-order.json`),
            JSON.stringify(order, null, 2),
          );
          assert.ok(order.paragraphs.every((p) => p.beforeChoices));
          assert.equal(order.targetBeforeChoices, true);
          assert.match(order.selected, /✓/);
          assert.equal(await details.locator('form,input,select,textarea,button,a').count(), 0);
          assert.equal(await card.getByTestId('decision-result-label').count(), 1);
          assert.equal(await label.innerText(), resultText);
          assert.equal(
            await card.locator(':focus-visible').count(),
            0,
            'Ordinary mouse disclosure has no keyboard focus ring',
          );
          if (width === 390 && entry.kind === 'url')
            await card.screenshot({ path: path.join(evidence, 'elicitation-390-after.png'), animations: 'disabled' });
          originals.push({
            width,
            kind: entry.kind,
            messageId: entry.pending.cardRef.messageId,
            order,
            resultText,
            terminal: await f.store.get(entry.pending.request.interactionId),
          });
          await card.locator('button[aria-expanded=true]').first().click();
        }
      }
      assert.deepEqual(providerHost.errors, []);
      assert.deepEqual(providerHost.writes, []);
      assert.deepEqual(f.queue.list(f.conversationThread.id, 'default-user'), []);
      await writeFile(
        path.join(evidence, 'proof.json'),
        JSON.stringify(
          {
            head: process.env.F322_INBOX_PARITY_HEAD,
            language,
            metadata,
            originals,
            errors: hosts.flatMap((host) => host.errors),
            writes: hosts.flatMap((host) => host.writes),
            boundary:
              'Original feature-worktree Next hosts and isolated original owner/producer/store fixtures. Four original provider requests across the two languages are declined through the real service to create historical specimens; no browser decision writes, provider/model invocation, Alpha/runtime writes or unrelated journey reruns.',
          },
          null,
          2,
        ),
      );
      completed = true;
    });
}
