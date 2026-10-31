import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { loadExampleRecommendedRegistryNames, ROOT, readEnvFile, readEnvTemplateKeys } from './context.mjs';

export function registerEnvTemplatePart1() {
  const env = readEnvFile('.env.example.opensource');

  const envTemplateKeys = readEnvTemplateKeys('.env.example.opensource');

  const recommendedRegistryNames = loadExampleRecommendedRegistryNames();

  it('API_SERVER_PORT matches sync convention (3004)', () => {
    assert.equal(
      env.API_SERVER_PORT,
      '3004',
      `API_SERVER_PORT should be 3004 (open-source convention), got ${env.API_SERVER_PORT}`,
    );
  });

  it('FRONTEND_PORT matches sync convention (3003)', () => {
    assert.equal(
      env.FRONTEND_PORT,
      '3003',
      `FRONTEND_PORT should be 3003 (open-source convention), got ${env.FRONTEND_PORT}`,
    );
  });

  it('NEXT_PUBLIC_API_URL uses API port (3004)', () => {
    assert.equal(
      env.NEXT_PUBLIC_API_URL,
      'http://localhost:3004',
      `NEXT_PUBLIC_API_URL should point to API port 3004, got ${env.NEXT_PUBLIC_API_URL}`,
    );
  });

  it('REDIS_PORT stays on 6399', () => {
    assert.equal(env.REDIS_PORT, '6399', `REDIS_PORT should stay 6399, got ${env.REDIS_PORT}`);
  });

  it('REDIS_URL stays on localhost:6399', () => {
    assert.equal(
      env.REDIS_URL,
      'redis://localhost:6399',
      `REDIS_URL should stay on localhost:6399, got ${env.REDIS_URL}`,
    );
  });

  it('.env.example.opensource comment header documents correct ports', () => {
    const content = readFileSync(resolve(ROOT, '.env.example.opensource'), 'utf-8');
    // The comment should say Frontend=3003, API=3004
    assert.ok(content.includes('3004') && content.includes('3003'), 'Comment header should mention both 3003 and 3004');
  });

  it('includes every exampleRecommended env var from env-registry', () => {
    const missing = [...recommendedRegistryNames].filter((name) => !envTemplateKeys.has(name));
    assert.deepEqual(
      missing,
      [],
      `Missing exampleRecommended env vars in .env.example.opensource: ${missing.join(', ')}`,
    );
  });

  it('documents the private-network access pair for LAN / Tailscale setups', () => {
    assert.ok(envTemplateKeys.has('API_SERVER_HOST'), 'Expected .env.example.opensource to document API_SERVER_HOST');
    assert.ok(
      envTemplateKeys.has('CORS_ALLOW_PRIVATE_NETWORK'),
      'Expected .env.example.opensource to document CORS_ALLOW_PRIVATE_NETWORK',
    );
  });
}
