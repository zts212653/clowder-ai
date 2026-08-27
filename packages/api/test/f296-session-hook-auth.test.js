import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const { buildChildEnv } = await import('../dist/utils/cli-spawn.js');

describe('F296 invocation-scoped session hook authentication', () => {
  test('generic child environments never inherit the legacy process-scoped hook bearer', () => {
    const previous = process.env.CAT_CAFE_HOOK_TOKEN;
    try {
      process.env.CAT_CAFE_HOOK_TOKEN = 'process-scoped-hook-token';
      const childEnv = buildChildEnv();
      assert.equal(childEnv.CAT_CAFE_HOOK_TOKEN, undefined);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_HOOK_TOKEN;
      else process.env.CAT_CAFE_HOOK_TOKEN = previous;
    }
  });

  test('all Claude project hooks use the invocation callback pair and never the legacy global bearer', () => {
    for (const relativePath of [
      '../../../.claude/hooks/f24-pre-compact.sh',
      '../../../.claude/hooks/f24-post-compact-bootstrap.sh',
      '../../../.claude/hooks/sop-stage-bookmark.sh',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      assert.match(source, /X-Invocation-Id:/, relativePath);
      assert.match(source, /X-Callback-Token:/, relativePath);
      assert.doesNotMatch(source, /CAT_CAFE_HOOK_TOKEN|X-Cat-Cafe-Hook-Token/, relativePath);
    }
  });

  test('production composition gives session hooks the callback registry without creating another secret', () => {
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const registrySource = readFileSync(new URL('../src/config/env-registry.ts', import.meta.url), 'utf8');

    assert.match(indexSource, /callbackRegistry:\s*registry/);
    assert.match(indexSource, /hookAuthenticationReady:\s*sessionHookAuthenticationReady/);
    assert.doesNotMatch(indexSource, /initializeSessionHookAuthentication|sessionHookAuth\.token/);
    assert.doesNotMatch(registrySource, /CAT_CAFE_HOOK_TOKEN/);
  });
});
