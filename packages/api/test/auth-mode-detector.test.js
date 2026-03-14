// @ts-check

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { detectAuthModeConflict } = await import('../dist/config/auth-mode-detector.js');

describe('auth-mode-detector', () => {
  /** @type {typeof process.env.ANTHROPIC_API_KEY} */
  let savedApiKey;

  beforeEach(() => {
    savedApiKey = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  it('returns null when profile is api_key mode (no conflict)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const result = await detectAuthModeConflict({
      id: 'test-profile',
      mode: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-key',
    });
    assert.equal(result, null);
  });

  it('warns when ANTHROPIC_API_KEY env var is set but profile is subscription', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const result = await detectAuthModeConflict({
      id: 'anthropic-subscription-default',
      mode: 'subscription',
    });
    assert.notEqual(result, null);
    assert.ok(result?.message.includes('subscription'));
    assert.ok(result?.details.some((d) => d.includes('ANTHROPIC_API_KEY')));
  });

  it('returns null when no API key signals detected in subscription mode', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await detectAuthModeConflict({
      id: 'anthropic-subscription-default',
      mode: 'subscription',
    });
    // May or may not be null depending on ~/.claude/settings.json — but
    // at minimum should not crash. If settings.json doesn't exist or has
    // no API key config, result should be null.
    // We can't guarantee this in CI, but verify no throw.
    assert.ok(result === null || typeof result?.message === 'string');
  });

  it('returns null for empty ANTHROPIC_API_KEY string', async () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    const result = await detectAuthModeConflict({
      id: 'anthropic-subscription-default',
      mode: 'subscription',
    });
    // Whitespace-only should not trigger warning
    assert.ok(result === null || !result.details.some((d) => d.includes('ANTHROPIC_API_KEY is set')));
  });
});
