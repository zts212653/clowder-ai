import assert from 'node:assert/strict';

export async function assertHistoricalMapGeometry(history, authoredStory) {
  assert.deepEqual(
    await history.locator('.exploration-node-period').allTextContents(),
    authoredStory.nodes.map((entry) => entry.when),
    'each historical card keeps its authored date on a dedicated line',
  );
  assert.deepEqual(
    await history.locator('.exploration-node-heading').allTextContents(),
    authoredStory.nodes.map((entry) => entry.title),
    'each historical card keeps the full authored title without rendering body excerpts',
  );
  const titleStyles = await history.locator('.exploration-node-heading').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return { whiteSpace: style.whiteSpace, lineClamp: style.webkitLineClamp };
    }),
  );
  assert.ok(titleStyles.every((style) => style.whiteSpace === 'normal' && style.lineClamp === '2'));
  const cardBoxes = await history.locator('.exploration-node-wrap').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  for (const [index, box] of cardBoxes.entries()) {
    for (const [offset, other] of cardBoxes.slice(index + 1).entries()) {
      assert.ok(
        box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top,
        `historical cards ${index + 1} and ${index + offset + 2} must not overlap`,
      );
    }
  }
  const overflowingCards = await history
    .locator('.exploration-node')
    .evaluateAll((nodes) =>
      nodes
        .map((node, index) => ({ index, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }))
        .filter((box) => box.scrollHeight > box.clientHeight + 1),
    );
  assert.deepEqual(overflowingCards, [], 'historical card content must fit inside the card at its readable zoom floor');
  const chronology = await history
    .locator('.exploration-node-wrap')
    .evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(node.style.left)));
  assert.ok(chronology.every((left, index) => index === 0 || left > chronology[index - 1]));
  assert.equal(
    await history.locator('.exploration-edges path').count(),
    authoredStory.nodes.reduce((count, node) => count + node.parents.length, 0),
    'the map must draw every and only authored source relationship',
  );
}

export async function assertSelectedCardInsideCanvas(history) {
  const selectedBox = await history
    .locator('.exploration-node-wrap[data-selected="true"]')
    .evaluate((node) => node.getBoundingClientRect().toJSON());
  const canvasBox = await history
    .locator('.exploration-canvas')
    .evaluate((node) => node.getBoundingClientRect().toJSON());
  assert.ok(
    selectedBox.left >= canvasBox.left &&
      selectedBox.right <= canvasBox.right &&
      selectedBox.top >= canvasBox.top &&
      selectedBox.bottom <= canvasBox.bottom,
    'locating a historical step must place its whole card inside the canvas',
  );
}
