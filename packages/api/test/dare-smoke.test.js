/**
 * DARE Smoke Test
 *
 * Actually invokes the DARE CLI in headless mode to verify end-to-end integration.
 * Requires:
 *   - DARE repo at DARE_PATH (or /tmp/cat-cafe-reviews/Deterministic-Agent-Runtime-Engine)
 *   - OPENROUTER_API_KEY in env
 *
 * Skip condition: if DARE_PATH is unset AND the default path doesn't exist,
 * or if OPENROUTER_API_KEY is missing, tests are skipped gracefully.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  DareAgentService,
  resolveVendorDarePath,
} from '../dist/domains/cats/services/agents/providers/DareAgentService.js';

// F135: prefer env DARE_PATH > vendor/dare-cli (if DARE exists there) > legacy /tmp path
const LEGACY_DARE_PATH = '/tmp/cat-cafe-reviews/Deterministic-Agent-Runtime-Engine';
const vendorPath = resolveVendorDarePath();
const vendorHasDare = existsSync(`${vendorPath}/client/__main__.py`);
const DARE_PATH = process.env.DARE_PATH || (vendorHasDare ? vendorPath : LEGACY_DARE_PATH);
const HAS_DARE = existsSync(`${DARE_PATH}/client/__main__.py`);
const HAS_KEY = !!process.env.OPENROUTER_API_KEY;

const SKIP_REASON = !HAS_DARE ? `DARE repo not found at ${DARE_PATH}` : !HAS_KEY ? 'OPENROUTER_API_KEY not set' : null;

describe('DARE Smoke Test', { skip: SKIP_REASON ?? false }, () => {
  test('DARE CLI responds to simple prompt via headless mode', { timeout: 60_000 }, async () => {
    const service = new DareAgentService({
      catId: 'dare',
      darePath: DARE_PATH,
      adapter: 'openrouter',
      model: 'qwen/qwen3-coder:free',
    });

    const messages = [];
    for await (const msg of service.invoke('Reply with exactly: DARE_SMOKE_OK')) {
      messages.push(msg);
    }

    const types = messages.map((m) => m.type);

    // P1-4 fix: Must have session_init — proves DARE CLI actually started
    assert.ok(
      types.includes('session_init'),
      `expected session_init (DARE CLI must start a session). Got types: ${types.join(', ')}`,
    );

    // session_init must have a sessionId
    const sessionInit = messages.find((m) => m.type === 'session_init');
    assert.ok(sessionInit.sessionId, 'session_init should have sessionId');

    // P1-4 fix: API-level errors (429, auth) are tolerated for free models,
    // but missing-module errors (python can't find client) must fail.
    const adapterErrors = messages.filter(
      (m) =>
        m.type === 'error' &&
        m.error &&
        (m.error.includes('No module named') || m.error.includes('ModuleNotFoundError')),
    );
    assert.strictEqual(
      adapterErrors.length,
      0,
      `DARE adapter must find client module: ${adapterErrors.map((e) => e.error).join('; ')}`,
    );

    // Must have done message
    assert.ok(types.includes('done'), `expected 'done' in message types: ${types.join(', ')}`);

    // If task completed, text content should exist
    const textMsg = messages.find((m) => m.type === 'text');
    if (textMsg) {
      assert.ok(textMsg.content.length > 0, 'text content should not be empty');
      assert.strictEqual(textMsg.catId, 'dare');
    }

    // Metadata must be present with correct provider
    const doneMsg = messages.find((m) => m.type === 'done');
    assert.ok(doneMsg.metadata, 'done message should have metadata');
    assert.strictEqual(doneMsg.metadata.provider, 'dare');
    assert.strictEqual(doneMsg.metadata.model, 'qwen/qwen3-coder:free');
  });
});
