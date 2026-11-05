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
      const card = node.querySelector('.exploration-node');
      if (!(card instanceof HTMLElement)) throw new Error('each historical node wrapper must contain its visible card');
      const box = card.getBoundingClientRect();
      return {
        key: node.getAttribute('data-key'),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
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
  const clippedTextBlocks = await history
    .locator('.exploration-node-period, .exploration-node-heading, .exploration-node-meta')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const clone = node.cloneNode(true);
          if (!(clone instanceof HTMLElement)) throw new Error('historical text clone must be measurable');
          Object.assign(clone.style, {
            position: 'fixed',
            inset: '0 auto auto -10000px',
            display: 'block',
            width: `${node.clientWidth}px`,
            height: 'auto',
            maxHeight: 'none',
            overflow: 'visible',
            webkitLineClamp: 'unset',
          });
          const measurementHost = node.parentElement;
          if (!measurementHost) throw new Error('historical text block must keep its layout parent');
          measurementHost.append(clone);
          const naturalHeight = clone.scrollHeight;
          clone.remove();
          return {
            className: node.className,
            clientHeight: node.clientHeight,
            naturalHeight,
            scrollHeight: node.scrollHeight,
            text: node.textContent?.trim() ?? '',
          };
        })
        .filter((block) => block.scrollHeight > block.clientHeight + 1 || block.naturalHeight > block.clientHeight + 1),
    );
  assert.deepEqual(
    clippedTextBlocks,
    [],
    'historical card dates, titles and notes must fit without line-clamp hiding authored text',
  );
  const chronology = await history
    .locator('.exploration-node-wrap')
    .evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(node.style.left)));
  assert.ok(chronology.every((left, index) => index === 0 || left > chronology[index - 1]));
  assert.equal(
    await history.locator('.exploration-edges path').count(),
    authoredStory.nodes.reduce((count, node) => count + node.parents.length, 0),
    'the map must draw every and only authored source relationship',
  );
  const renderedEdges = await history.locator('.exploration-edges path').evaluateAll((paths) =>
    paths.map((path) => ({
      parentKey: path.getAttribute('data-parent-key'),
      childKey: path.getAttribute('data-child-key'),
    })),
  );
  for (let childIndex = 1; childIndex < authoredStory.nodes.length; childIndex += 1) {
    const parentIndex = childIndex - 1;
    const parent = authoredStory.nodes[parentIndex];
    const child = authoredStory.nodes[childIndex];
    if (!child.parents.some((edge) => edge.nodeId === parent.id)) continue;
    const parentBox = cardBoxes[parentIndex];
    const childBox = cardBoxes[childIndex];
    assert.ok(
      renderedEdges.some((edge) => edge.parentKey === parentBox.key && edge.childKey === childBox.key),
      `adjacent authored edge ${parent.id} → ${child.id} must be rendered`,
    );
    assert.ok(
      childBox.left - parentBox.right >= 16,
      `adjacent authored edge ${parent.id} → ${child.id} must expose at least 16px between visible cards; got ${childBox.left - parentBox.right}px`,
    );
  }
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
