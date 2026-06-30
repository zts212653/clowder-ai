/**
 * F236 Phase C — Tests for cat_cafe_set_read_mode MCP tool handler.
 *
 * Tests the handleSetReadMode function that writes/removes mode files.
 *
 * Convention: node:test (project test runner).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { handleSetReadMode } from '../../mcp-server/dist/tools/callback-tools.js';

const TEST_INVOCATION_ID = `test-read-mode-${process.pid}`;
const MODE_PATH = `/tmp/cat-cafe-anchor-mode-${TEST_INVOCATION_ID}`;

describe('handleSetReadMode', () => {
  let originalInvocationId;

  beforeEach(() => {
    originalInvocationId = process.env.CAT_CAFE_INVOCATION_ID;
    process.env.CAT_CAFE_INVOCATION_ID = TEST_INVOCATION_ID;
    // Clean slate
    rmSync(MODE_PATH, { force: true });
  });

  afterEach(() => {
    if (originalInvocationId !== undefined) {
      process.env.CAT_CAFE_INVOCATION_ID = originalInvocationId;
    } else {
      delete process.env.CAT_CAFE_INVOCATION_ID;
    }
    rmSync(MODE_PATH, { force: true });
  });

  it('mode="anchor" → creates mode file with "anchor" content', async () => {
    const result = await handleSetReadMode({ mode: 'anchor' });
    assert.ok(!result.isError, `Expected success, got: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, 'anchor');
    assert.strictEqual(parsed.path, MODE_PATH);
    // Verify file on disk
    assert.ok(existsSync(MODE_PATH));
    assert.strictEqual(readFileSync(MODE_PATH, 'utf-8'), 'anchor');
  });

  it('mode="full" → removes mode file (fail-open)', async () => {
    // Pre-create mode file
    writeFileSync(MODE_PATH, 'anchor');
    assert.ok(existsSync(MODE_PATH));

    const result = await handleSetReadMode({ mode: 'full' });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, 'full');
    // Verify file removed
    assert.ok(!existsSync(MODE_PATH));
  });

  it('mode="full" is idempotent (no file → still succeeds)', async () => {
    assert.ok(!existsSync(MODE_PATH));
    const result = await handleSetReadMode({ mode: 'full' });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ok, true);
  });

  it('mode="anchor" is idempotent (already anchor → overwrites)', async () => {
    writeFileSync(MODE_PATH, 'anchor');
    const result = await handleSetReadMode({ mode: 'anchor' });
    assert.ok(!result.isError);
    assert.strictEqual(readFileSync(MODE_PATH, 'utf-8'), 'anchor');
  });

  it('errors when CAT_CAFE_INVOCATION_ID is not set', async () => {
    delete process.env.CAT_CAFE_INVOCATION_ID;
    const result = await handleSetReadMode({ mode: 'anchor' });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('CAT_CAFE_INVOCATION_ID'));
  });

  // Stateful lifecycle test — verify mode transitions
  it('anchor → full → anchor cycle works correctly', async () => {
    // Start: no mode file (fail-open)
    assert.ok(!existsSync(MODE_PATH));

    // Set anchor
    await handleSetReadMode({ mode: 'anchor' });
    assert.strictEqual(readFileSync(MODE_PATH, 'utf-8'), 'anchor');

    // Switch to full
    await handleSetReadMode({ mode: 'full' });
    assert.ok(!existsSync(MODE_PATH));

    // Back to anchor
    await handleSetReadMode({ mode: 'anchor' });
    assert.strictEqual(readFileSync(MODE_PATH, 'utf-8'), 'anchor');
  });
});
