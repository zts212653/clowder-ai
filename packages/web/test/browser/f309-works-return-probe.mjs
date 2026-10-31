import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Controlled layout rows match the mixed, fully loaded Works list from the parent Alpha RED. */
export function mixedWorks(artifact) {
  return [
    'image',
    'image',
    'image',
    'file',
    'widget',
    'file',
    'file',
    'image',
    'image',
    'target',
    'image',
    'image',
    'code',
  ].map((type, index) =>
    type === 'target'
      ? artifact
      : {
          type,
          name:
            type === 'widget'
              ? 'Private layout report with several lines of detail. '.repeat(16)
              : `Private layout ${index}.${type === 'file' ? 'md' : 'png'}`,
          catId: artifact.catId,
          createdAt: artifact.createdAt + 9 - index,
          sourceMessageId: `layout-row-${index}`,
          ...(type === 'image'
            ? {
                url: artifact.url,
                publicationItem: { kind: 'media-gallery', blockId: `layout-${index}`, itemIndex: 0 },
              }
            : {}),
        },
  );
}

/** A repeated same-position return retains the host's existing Works component/key. */
export async function verifyRepeatedWorksReturn({ page, card, surface, artifact, expectedScroll, evidence, label }) {
  const observations = [];
  try {
    for (const round of [1, 2]) {
      await surface.getByRole('button', { name: '‹ 作品', exact: true }).click();
      await card.waitFor();
      await page.waitForLoadState('networkidle');
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.querySelectorAll('.v2-works-scroll img')].map((image) => image.decode()));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const returned = await card.evaluate((node) => {
        const list = node.closest('.v2-works-scroll');
        return {
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          card: node.getBoundingClientRect().toJSON(),
          images: [...list.querySelectorAll('img')].map((image) => ({
            complete: image.complete,
            naturalWidth: image.naturalWidth,
          })),
        };
      });
      observations.push({ round, expectedScroll, ...returned });
      await page.screenshot({ path: `${evidence}/${label}-return-${round}.png` });
      assert.ok(Math.abs(returned.scrollTop - expectedScroll) < 2, `return ${round}: ${JSON.stringify(returned)}`);
      if (round === 2) break;
      await card.click();
      const preview = page.getByRole('dialog', { name: artifact.name, exact: true });
      await preview.getByRole('button', { name: '批注', exact: true }).click();
      const choice = page.getByRole('button', { name: /^继续.+的审阅：/ });
      if (await choice.isVisible()) await choice.click();
      await surface.waitFor();
    }
  } finally {
    await writeFile(`${evidence}/${label}-returns.json`, JSON.stringify(observations, null, 2));
  }
}
