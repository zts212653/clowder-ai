import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ACCOUNT_AUTH_ENV_KEYS, isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

it('auth isolation restores outer values and absent variables after an inner fixture', () => {
  const previous = new Map(ACCOUNT_AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.ANTHROPIC_API_KEY = 'outer-fixture-key';
    process.env.ANTHROPIC_BASE_URL = 'https://outer-fixture.invalid';
    process.env.GEMINI_BASE_URL = '';
    delete process.env.OPENAI_API_BASE;
    const restore = isolateAccountAuthEnvironment();
    try {
      assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
      process.env.ANTHROPIC_API_KEY = 'inner-fixture-key';
      process.env.OPENAI_API_BASE = 'https://inner-fixture.invalid';
    } finally {
      restore();
    }
    assert.equal(process.env.ANTHROPIC_API_KEY, 'outer-fixture-key');
    assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://outer-fixture.invalid');
    assert.equal(process.env.GEMINI_BASE_URL, '');
    assert.equal(process.env.OPENAI_API_BASE, undefined);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
