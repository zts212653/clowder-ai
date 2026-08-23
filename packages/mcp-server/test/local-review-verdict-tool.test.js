import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';

import {
  handleLocalReviewVerdict,
  handleRecoverLocalReviewVerdict,
  localReviewRecoveryInputSchema,
  localReviewVerdictInputSchema,
  localReviewVerdictTools,
} from '../dist/tools/local-review-verdict-tool.js';

describe('cat_cafe_record_local_review_verdict', () => {
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
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'invocation-1';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-1';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv('CAT_CAFE_API_URL', originalEnv.apiUrl);
    restoreEnv('CAT_CAFE_INVOCATION_ID', originalEnv.invocationId);
    restoreEnv('CAT_CAFE_CALLBACK_TOKEN', originalEnv.callbackToken);
    restoreEnv('CAT_CAFE_CREDENTIAL_FILE', originalEnv.credentialFile);
  });

  it('accepts only a durable typed-message locator and optional exact carrier fence', () => {
    const schema = z.object(localReviewVerdictInputSchema);
    assert.equal(
      schema.safeParse({
        messageId: 'message-1',
      }).success,
      true,
    );
    assert.equal(schema.safeParse({ messageId: 'message:1' }).success, false);
    assert.equal(schema.safeParse({ messageId: 'message 1' }).success, false);
  });

  it('posts the bounded completion packet to the invocation callback', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      const body = { outcome: 'committed', evidenceRef: 'local-review:message-1:g2:approved' };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };

    const result = await handleLocalReviewVerdict({
      messageId: 'message-1',
      actionLeaseRef: { leaseId: 'lease-1', generation: 2 },
    });

    assert.match(result.content[0].text, /"outcome":"committed"/);
    assert.equal(requests[0].url, 'http://127.0.0.1:3003/api/callbacks/record-local-review-verdict');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      messageId: 'message-1',
      actionLeaseRef: { leaseId: 'lease-1', generation: 2 },
    });
  });

  it('documents that verdict text must be posted before completion is recorded', () => {
    const description = localReviewVerdictTools[0].description;
    assert.match(description, /Use when:/);
    assert.match(description, /NOT for:/);
    assert.match(description, /Output:/);
    assert.match(description, /GOTCHA:/);
    assert.match(description, /post_message|cross_post_message/);
  });

  it('posts a bounded predecessor recovery packet with an explicit exact fence', async () => {
    const schema = z.object(localReviewRecoveryInputSchema);
    const packet = {
      messageId: 'message-stale-verdict-1',
      actionLeaseRef: { leaseId: 'lease-stale-review-1', generation: 1 },
    };
    assert.equal(schema.safeParse(packet).success, true);
    assert.equal(schema.safeParse({ ...packet, actionLeaseRef: undefined }).success, false);

    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      const body = { outcome: 'committed', evidenceRef: 'local-review:message-stale-verdict-1:g1:changes_requested' };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };

    const result = await handleRecoverLocalReviewVerdict(packet);
    assert.match(result.content[0].text, /"outcome":"committed"/);
    assert.equal(requests[0].url, 'http://127.0.0.1:3003/api/callbacks/recover-local-review-verdict');
    assert.deepEqual(JSON.parse(requests[0].options.body), packet);

    const recoveryTool = localReviewVerdictTools.find((tool) => tool.name === 'cat_cafe_recover_local_review_verdict');
    assert.ok(recoveryTool);
    assert.match(recoveryTool.description, /persisted predecessor/);
    assert.match(recoveryTool.description, /NOT for:/);
    assert.match(recoveryTool.description, /ordinary active replacement/);
  });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
