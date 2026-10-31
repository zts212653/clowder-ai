import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProviderEndpoint } from '../dist/config/provider-endpoint.js';

const resources = {
  anthropic: 'messages',
  openai: 'chat/completions',
  'openai-responses': 'responses',
  kimi: 'chat/completions',
  google: 'models/gemini-test:generateContent',
};

for (const [protocol, resource] of Object.entries(resources)) {
  for (const basePath of ['', '/', '/v1', '/v1/', '/gateway/v1', '/v1beta']) {
    test(`${protocol} composes ${basePath || 'root'} once and preserves query/hash`, () => {
      const version = protocol === 'google' ? 'v1beta' : 'v1';
      const expectedPath = !basePath || basePath === '/' ? `/${version}` : basePath.replace(/\/$/, '');
      const input = {
        protocol,
        baseUrl: `https://gateway.invalid${basePath}?tenant=a%26b#fixture`,
        model: 'gemini-test',
      };
      const expected = `https://gateway.invalid${expectedPath}/${resource}?tenant=a%26b#fixture`;
      const actual = buildProviderEndpoint(input);
      assert.equal(actual, expected);
      assert.equal(buildProviderEndpoint({ ...input, baseUrl: actual }), expected);
    });
  }
}

test('Google key is a single encoded query parameter; model cannot inject a query or path', () => {
  const key = 'FAKE&other=value+#?/';
  const url = new URL(
    buildProviderEndpoint({
      protocol: 'google',
      baseUrl: 'https://gateway.invalid/v1beta?tenant=a&key=old#fragment',
      model: 'gemini/test?x=y',
      apiKey: key,
    }),
  );
  assert.equal(url.pathname, '/v1beta/models/gemini%2Ftest%3Fx%3Dy:generateContent');
  assert.deepEqual(
    [...url.searchParams],
    [
      ['tenant', 'a'],
      ['key', key],
    ],
  );
  assert.equal(url.hash, '#fragment');
});

for (const protocol of Object.keys(resources)) {
  for (const baseUrl of ['file:///tmp/api', 'ftp://gateway.invalid', 'data:text/plain,fixture', 'not a URL', '']) {
    test(`${protocol} rejects ${baseUrl || 'empty base'} before networking`, () => {
      assert.throws(() => buildProviderEndpoint({ protocol, baseUrl, model: 'fixture' }), /http|URL/i);
    });
  }
}

test('HTTP gateway remains supported and root-style OpenAI gets v1', () => {
  assert.equal(
    buildProviderEndpoint({ protocol: 'openai', baseUrl: 'http://gateway.invalid/proxy' }),
    'http://gateway.invalid/proxy/v1/chat/completions',
  );
});
