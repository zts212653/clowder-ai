import assert from 'node:assert/strict';

/** Inspect painted glyphs inside the original metadata clip, independently of its wrapping implementation. */
export async function readGitHubMetadataLines(pr) {
  return pr.evaluate((card) =>
    ['prRepository', 'prStatus'].map((name) => {
      const group = card.querySelector(`[class*="${name}"]`);
      if (!group) throw new Error(`Missing original metadata group ${name}`);
      const clip = group.getBoundingClientRect();
      const overflowX = getComputedStyle(group).overflowX;
      const clips = ['clip', 'hidden', 'auto', 'scroll'].includes(overflowX);
      const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
      const glyphs = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let index = 0; index < node.textContent.length; index += 1) {
          const character = node.textContent[index];
          if (/\s/u.test(character)) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          for (const rect of range.getClientRects()) {
            const visibleLeft = clips ? Math.max(rect.left, clip.left) : rect.left;
            const visibleRight = clips ? Math.min(rect.right, clip.right) : rect.right;
            if (visibleRight - visibleLeft <= 0.1 || rect.height <= 0) continue;
            glyphs.push({ character, rect: rect.toJSON(), visibleLeft, visibleRight });
          }
        }
      }
      const lines = [];
      for (const glyph of glyphs.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
        let line = lines.find(
          (candidate) =>
            Math.min(candidate.bottom, glyph.rect.bottom) - Math.max(candidate.top, glyph.rect.top) >
            Math.min(candidate.bottom - candidate.top, glyph.rect.height) / 2,
        );
        if (!line) {
          line = { top: glyph.rect.top, bottom: glyph.rect.bottom, glyphs: [] };
          lines.push(line);
        }
        line.glyphs.push(glyph);
      }
      return {
        name,
        overflowX,
        clip: clip.toJSON(),
        text: group.textContent,
        units: [...group.querySelectorAll('span[title]')].map((unit, index) => ({
          index,
          title: unit.getAttribute('title'),
          text: unit.textContent,
          whiteSpace: getComputedStyle(unit).whiteSpace,
        })),
        lines: lines.map((line) => ({
          top: line.top,
          bottom: line.bottom,
          text: line.glyphs
            .sort((a, b) => a.rect.left - b.rect.left)
            .map((glyph) => glyph.character)
            .join(''),
          glyphs: line.glyphs,
        })),
      };
    }),
  );
}

export function assertGitHubMetadataLines(groups) {
  for (const group of groups) {
    assert.ok(group.lines.length > 0, `${group.name} has visible text`);
    for (const line of group.lines) {
      assert.ok(!line.text.startsWith('·'), `${group.name}: no visible separator at line start (${line.text})`);
      assert.ok(!line.text.endsWith('·'), `${group.name}: no visible separator at line end (${line.text})`);
    }
    for (const unit of group.units) {
      assert.equal(unit.text, `${unit.index === 0 ? '' : ' · '}${unit.title}`);
      assert.equal(unit.whiteSpace, 'nowrap');
    }
  }
}
