import assert from 'node:assert/strict';
import test from 'node:test';
import { projectBuiltinCloudIdentityProtection } from '../dist/index.js';

test('only the Host cloud account remains a protected built-in identity', () => {
  assert.equal(
    projectBuiltinCloudIdentityProtection({
      id: 'gpt-dot',
      clientId: 'openai',
      provider: 'openai-chatgpt-pro',
      defaultModel: 'ChatGPT dot',
      mcpSupport: true,
      mentionPatterns: ['@dot'],
    }),
    undefined,
  );

  assert.equal(
    projectBuiltinCloudIdentityProtection({
      id: 'gpt-pro',
      breedId: 'gpt-pro',
      clientId: 'openai',
      provider: 'openai-chatgpt-pro',
      defaultModel: 'gpt-pro',
      accountRef: 'codex',
      mcpSupport: true,
      mentionPatterns: ['@gpt-pro'],
    })?.state,
    'healthy',
  );
});
