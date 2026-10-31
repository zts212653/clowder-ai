import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const skinDirectory = new URL('../public/concierge/skins/xianxian-codex/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('pet.json', skinDirectory), 'utf8'));
const {
  cellWidth: CELL_WIDTH,
  cellHeight: CELL_HEIGHT,
  columns: COLUMNS,
  rows: ROWS,
  totalWidth: TOTAL_WIDTH,
  totalHeight: TOTAL_HEIGHT,
} = manifest.atlas;
const atlasPath = fileURLToPath(new URL(manifest.atlas.src, skinDirectory));

function readTransparentCell(rgba, atlasWidth, row, column) {
  const transparent = new Uint8Array(CELL_WIDTH * CELL_HEIGHT);
  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    for (let x = 0; x < CELL_WIDTH; x += 1) {
      const atlasX = column * CELL_WIDTH + x;
      const atlasY = row * CELL_HEIGHT + y;
      const alpha = rgba[(atlasY * atlasWidth + atlasX) * 4 + 3];
      transparent[y * CELL_WIDTH + x] = alpha <= 8 ? 1 : 0;
    }
  }
  return transparent;
}

function markExteriorTransparency(transparent) {
  const exterior = new Uint8Array(transparent.length);
  const queue = new Int32Array(transparent.length);
  let queueStart = 0;
  let queueEnd = 0;

  const admit = (x, y) => {
    const index = y * CELL_WIDTH + x;
    if (!transparent[index] || exterior[index]) return;
    exterior[index] = 1;
    queue[queueEnd] = index;
    queueEnd += 1;
  };

  for (let x = 0; x < CELL_WIDTH; x += 1) {
    admit(x, 0);
    admit(x, CELL_HEIGHT - 1);
  }
  for (let y = 1; y < CELL_HEIGHT - 1; y += 1) {
    admit(0, y);
    admit(CELL_WIDTH - 1, y);
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart];
    queueStart += 1;
    const x = index % CELL_WIDTH;
    const y = Math.floor(index / CELL_WIDTH);
    if (x > 0) admit(x - 1, y);
    if (x + 1 < CELL_WIDTH) admit(x + 1, y);
    if (y > 0) admit(x, y - 1);
    if (y + 1 < CELL_HEIGHT) admit(x, y + 1);
  }

  return exterior;
}

function enclosedTransparentPixels(rgba, atlasWidth, row, column) {
  const transparent = readTransparentCell(rgba, atlasWidth, row, column);
  const exterior = markExteriorTransparency(transparent);

  let enclosed = 0;
  for (let index = 0; index < transparent.length; index += 1) {
    if (transparent[index] && !exterior[index]) enclosed += 1;
  }
  return enclosed;
}

function opaqueBounds(rgba, atlasWidth, row, column) {
  let minX = CELL_WIDTH;
  let minY = CELL_HEIGHT;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    for (let x = 0; x < CELL_WIDTH; x += 1) {
      const atlasX = column * CELL_WIDTH + x;
      const atlasY = row * CELL_HEIGHT + y;
      const alpha = rgba[(atlasY * atlasWidth + atlasX) * 4 + 3];
      if (alpha <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  assert.ok(maxX >= minX && maxY >= minY, `atlas cell ${row}:${column} must contain a visible sprite`);
  return {
    height: maxY - minY + 1,
    bottom: maxY + 1,
  };
}

test('xianxian atlas does not punch chroma-key holes through the cat', async () => {
  const { data, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(TOTAL_WIDTH, CELL_WIDTH * COLUMNS);
  assert.equal(TOTAL_HEIGHT, CELL_HEIGHT * ROWS);
  assert.equal(info.width, TOTAL_WIDTH);
  assert.equal(info.height, TOTAL_HEIGHT);
  assert.equal(info.channels, 4);

  const failures = [];
  const stateRows = new Set();
  for (const [state, config] of Object.entries(manifest.states)) {
    const { frameCount, row } = config;
    assert.ok(Number.isInteger(row) && row >= 0 && row < ROWS, `${state} has an invalid atlas row`);
    assert.ok(
      Number.isInteger(frameCount) && frameCount > 0 && frameCount <= COLUMNS,
      `${state} has an invalid frame count`,
    );
    assert.equal(config.frameDurations.length, frameCount, `${state} frame durations must cover every frame`);
    assert.equal(stateRows.has(row), false, `atlas row ${row} is assigned more than once`);
    stateRows.add(row);

    for (let column = 0; column < frameCount; column += 1) {
      const enclosed = enclosedTransparentPixels(data, info.width, row, column);
      if (enclosed > 300) failures.push(`${state}[${column}]=${enclosed}`);
    }
  }
  assert.equal(stateRows.size, ROWS, 'manifest states must cover every atlas row exactly once');

  assert.deepEqual(
    failures,
    [],
    `background removal made large enclosed transparent holes inside used sprites: ${failures.join(', ')}`,
  );
});

test('xianxian idle keeps one visual scale and a stable ground line', async () => {
  const { data, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const idle = manifest.states.idle;
  const bounds = Array.from({ length: idle.frameCount }, (_, column) =>
    opaqueBounds(data, info.width, idle.row, column),
  );
  const heights = bounds.map(({ height }) => height);
  const bottoms = bounds.map(({ bottom }) => bottom);
  const heightSpread = Math.max(...heights) - Math.min(...heights);
  const groundSpread = Math.max(...bottoms) - Math.min(...bottoms);

  assert.ok(
    heightSpread <= 10 && groundSpread <= 5,
    `idle frames pulse instead of breathing in place: heights=${heights.join(',')} ` +
      `bottoms=${bottoms.join(',')} spreads=${heightSpread}/${groundSpread}`,
  );
});
