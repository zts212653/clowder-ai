import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';

import {
  communityRouteAcceptanceInputSchema,
  communityRouteAcceptanceTools,
  handleCommunityRouteAcceptance,
} from '../dist/tools/community-route-acceptance-tool.js';

describe('cat_cafe_validate_community_route', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = {
      apiUrl: process.env.CAT_CAFE_API_URL,
      invocationId: process.env.CAT_CAFE_INVOCATION_ID,
      callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN,
      credentialFile: process.env.CAT_CAFE_CREDENTIAL_FILE,
    };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3012';
    process.env.CAT_CAFE_INVOCATION_ID = 'invocation-route-owner';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-route-owner';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv('CAT_CAFE_API_URL', originalEnv.apiUrl);
    restoreEnv('CAT_CAFE_INVOCATION_ID', originalEnv.invocationId);
    restoreEnv('CAT_CAFE_CALLBACK_TOKEN', originalEnv.callbackToken);
    restoreEnv('CAT_CAFE_CREDENTIAL_FILE', originalEnv.credentialFile);
  });

  it('accepts only the route state-machine decisions', () => {
    const schema = z.object(communityRouteAcceptanceInputSchema);
    assert.equal(schema.safeParse({ issueId: 'msa-case-1', decision: 'accept' }).success, true);
    assert.equal(schema.safeParse({ issueId: 'msa-case-1', decision: 'reject', reason: 'Wrong thread' }).success, true);
    assert.equal(schema.safeParse({ issueId: 'msa-case-1', decision: 'accepted' }).success, false);
    assert.equal(schema.safeParse({ issueId: '', decision: 'accept' }).success, false);
  });

  it('posts through the invocation-authenticated callback bridge without exposing credentials to shell', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      const body = {
        id: 'msa-case/with space',
        state: 'accepted',
        assignedCatId: 'codex-sol',
        routeAcceptance: 'accepted',
      };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };

    const result = await handleCommunityRouteAcceptance({
      issueId: 'msa-case/with space',
      decision: 'accept',
      reason: 'Narrator WELCOME; Q1-Q5 PASS.',
    });

    assert.match(result.content[0].text, /"routeAcceptance":"accepted"/);
    assert.equal(requests[0].url, 'http://127.0.0.1:3012/api/community-issues/msa-case%2Fwith%20space/validate-route');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      decision: 'accept',
      reason: 'Narrator WELCOME; Q1-Q5 PASS.',
    });
    assert.equal(requests[0].options.headers['x-invocation-id'], 'invocation-route-owner');
    assert.equal(requests[0].options.headers['x-callback-token'], 'token-route-owner');
  });

  it('description states the identity and state-machine boundaries', () => {
    const description = communityRouteAcceptanceTools[0].description;
    assert.match(description, /Use when:/);
    assert.match(description, /NOT for:/);
    assert.match(description, /Output:/);
    assert.match(description, /GOTCHA:/);
    assert.match(description, /assigned cat/);
    assert.match(description, /routeAcceptance=pending/);
  });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
