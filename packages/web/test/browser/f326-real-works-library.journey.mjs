import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyAdoptedCovers } from './f326-real-works-covers.journey.mjs';
import { verifyMaterials, verifyPlayableMaterials } from './f326-real-works-materials.journey.mjs';
import { decodedSeek } from './f326-screening-journey.harness.mjs';

export async function verifyParagraphOpinion({ page, surface, evidence, reference, readContext, threadId }) {
  const indexed = await readContext(reference);
  const row = indexed.context.story[2];
  assert.ok(row, 'The delivered film has its actual sourced third paragraph');
  const expected = {
    kind: 'video-range',
    streamId: row.streamId,
    startTick: row.startPts,
    endTick: row.endPts,
    storyEvidence: { metadataRevision: indexed.metadataRevision, paragraphId: row.id, quote: row.text || row.title },
  };
  const attachment = page.locator('[data-context-kind="media"]');
  const before = await attachment.locator('[data-selection-id]').count();
  await surface
    .locator('[data-video-work-sidebar]')
    .getByRole('button', { name: '对这段提意见', exact: true })
    .nth(2)
    .click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-context-kind="media"] [data-selection-id]').length === count,
    before + 1,
  );
  const place = attachment.locator('[data-selection-id]').last();
  await place.getByRole('button', { name: '段落原文', exact: true }).click();
  assert.ok((await place.innerText()).includes(expected.storyEvidence.quote));
  const readDraft = () =>
    page.evaluate((id) => {
      const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') || '[]');
      return drafts.find(([key]) => key === id)?.[1]?.find((item) => item.kind === 'media');
    }, threadId);
  const draft = await readDraft();
  assert.equal(draft.source.contentRef, reference.contentRef);
  assert.equal(draft.source.ownerRevision, reference.ownerRevision);
  assert.deepEqual(draft.selections.at(-1).selection, expected);
  await page.screenshot({ path: path.join(evidence, 'frozen-paragraph-opinion.png'), fullPage: true });
  await writeFile(
    path.join(evidence, 'story-opinion.json'),
    JSON.stringify(
      {
        reference,
        beforeSelections: before,
        afterSelections: draft.selections.length,
        selection: expected,
        sent: false,
      },
      null,
      2,
    ),
  );
}

/** Author dogfood on the explicitly admitted private feature preview, not a gate fixture. */
export async function verifyDeliveredLibrary({ page, context, surface, evidence, readContext }) {
  const library = JSON.parse(await readFile(process.env.F326_C_LIBRARY_MANIFEST, 'utf8'));
  assert.equal(library.instance, 'f326-phase-c-sol61');
  assert.equal(library.catalogueVerified, true);
  assert.equal(library.works.length, 8);
  const observations = [];
  for (const work of library.works) {
    await surface.getByRole('button', { name: '‹ 作品', exact: true }).click();
    const catalogue = page.locator('[data-testid="v2-works-panel"]:visible');
    const card = catalogue.getByTestId('workspace-home-artifact-card').filter({ hasText: work.title });
    await card.waitFor({ state: 'visible' });
    await card.click();
    await surface.waitFor({ state: 'visible' });
    const version = surface.getByRole('combobox', { name: '作品版本', exact: true });
    const latest = work.versions.at(-1).reference.ownerRevision;
    await version.locator(`option[value="${latest}"]:checked`).waitFor({ state: 'attached' });
    assert.equal(await version.inputValue(), String(latest));
    const video = surface.locator('video').first();
    await video.waitFor({ state: 'visible' });
    // Reopening a film restores its viewport position at loadedmetadata. A test
    // seek issued before that native event would race the legitimate restoration.
    const element = await video.elementHandle();
    try {
      await page.waitForFunction((node) => node.readyState >= 2, element);
    } finally {
      await element.dispose();
    }
    const frame = await decodedSeek(video, 5);
    assert.ok(Math.abs(frame.mediaTime - 5) < 0.06 && !frame.seeking, JSON.stringify(frame));
    const sidebar = surface.locator('[data-video-work-sidebar]');
    await sidebar.getByRole('button').first().waitFor();
    assert.ok((await sidebar.getByRole('button').count()) > 0, `${work.key}: real source story is present`);
    const item = {
      key: work.key,
      reference: work.versions.at(-1).reference,
      decoded: frame,
      selectableVersions: await version.locator('option').count(),
    };
    assert.equal(item.selectableVersions, work.versions.length);
    if (work.key === 'ai-employment') {
      await surface.getByRole('button', { name: '对比版本', exact: true }).click();
      const compare = surface.getByRole('complementary', { name: '对比版本', exact: true });
      await compare.getByRole('combobox', { name: '左侧作品版本', exact: true }).selectOption('1');
      const original = compare.getByLabel('对比原件第 1 版', { exact: true });
      await original.waitFor();
      item.oldDecoded = await decodedSeek(original, 5);
      assert.ok(Math.abs(item.oldDecoded.mediaTime - 5) < 0.06);
      assert.ok((await original.getAttribute('src')).endsWith('/media/1'));
      assert.equal(
        await version.inputValue(),
        String(latest),
        'Opening v1 on the left never changes the right owner revision',
      );
      await page.screenshot({ path: path.join(evidence, 'real-v1-v4-comparison.png'), fullPage: true });
      await compare.getByRole('button', { name: '返回看片', exact: true }).click();
    }
    if (work.key === 'rsi-vision') await verifyMaterials({ page, context, sidebar, evidence, readContext, item });
    if (work.key === 'builder-day')
      item.materialPlayback = await verifyPlayableMaterials({
        page,
        sidebar,
        evidence,
        record: await readContext(item.reference),
      });
    if (work.key === 'cat-planet')
      item.adoptedCovers = await verifyAdoptedCovers({
        page,
        sidebar,
        evidence,
        record: await readContext(item.reference),
      });
    observations.push(item);
    await writeFile(
      path.join(evidence, 'library-result.json'),
      JSON.stringify({ works: observations, phaseAcceptance: false }, null, 2),
    );
  }
  assert.equal(observations.length, 8);
  await page.screenshot({ path: path.join(evidence, 'eight-work-last.png'), fullPage: true });
  return observations;
}
