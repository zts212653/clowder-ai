import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('F276 recall and lifecycle MCP tools', () => {
  let originalEnv;
  let originalFetch;
  const requests = [];

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    requests.length = 0;
    globalThis.fetch = async (url, options) => {
      requests.push({
        url,
        method: options.method,
        ...(options.body ? { body: JSON.parse(options.body) } : {}),
      });
      return { ok: true, json: async () => ({ status: 'not_available' }) };
    };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('registers live status, owner-derived recall, drill, correction, retire, amend and forget tools', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const names = [
      'cat_cafe_get_person_memory_proposal_status',
      'cat_cafe_recall_person_relationship',
      'cat_cafe_drill_person_memory',
      'cat_cafe_correct_person_claim',
      'cat_cafe_retire_person_claim',
      'cat_cafe_amend_person_interaction',
      'cat_cafe_redact_person_memory_item',
      'cat_cafe_forget_person',
      'cat_cafe_forget_person_memory_proposal',
    ];
    for (const name of names) {
      const tool = callbackTools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} should be registered`);
      assert.equal('ownerUserId' in tool.inputSchema, false);
    }
    const statusTool = callbackTools.find((entry) => entry.name === 'cat_cafe_get_person_memory_proposal_status');
    assert.match(statusTool.description, /Use when:/);
    assert.match(statusTool.description, /NOT for:/);
    assert.match(statusTool.description, /Output:/);
    assert.match(statusTool.description, /GOTCHA:/);
    assert.match(statusTool.inputSchema.proposalId.description, /Exact F276 candidate ID/);
    assert.match(statusTool.inputSchema.agentKeyCatId.description, /Persistent-agent identity selector/);
  });

  test('resolves proposal status through the callback-authenticated live read', async () => {
    const { handleGetPersonMemoryProposalStatus } = await import('../dist/tools/callback-tools.js');
    await handleGetPersonMemoryProposalStatus({
      proposalId: 'person_candidate_live_status',
    });
    assert.match(requests[0].url, /\/api\/callbacks\/person-memory\/proposals\/person_candidate_live_status\/status$/);
    assert.equal(requests[0].method ?? 'GET', 'GET');
    assert.equal(requests[0].body, undefined);
  });

  test('routes recall and hard forget without accepting caller-selected ownership', async () => {
    const { handleForgetPerson, handleForgetPersonMemoryProposal, handleRecallPersonRelationship } = await import(
      '../dist/tools/callback-tools.js'
    );
    await handleRecallPersonRelationship({ alias: '黄挺' });
    await handleForgetPerson({ personId: 'person_recall' });
    await handleForgetPersonMemoryProposal({ proposalId: 'person_candidate_unbound' });
    assert.match(requests[0].url, /\/api\/callbacks\/person-memory\/recall$/);
    assert.deepEqual(requests[0].body.alias, '黄挺');
    assert.equal(requests[0].body.ownerUserId, undefined);
    assert.match(requests[1].url, /\/api\/callbacks\/person-memory\/forget$/);
    assert.match(requests[1].body.requestId, /^person_forget_/);
    assert.equal(requests[1].body.ownerUserId, undefined);
    assert.match(requests[2].url, /\/api\/callbacks\/person-memory\/forget-proposal$/);
    assert.equal(requests[2].body.proposalId, 'person_candidate_unbound');
    assert.match(requests[2].body.requestId, /^person_forget_proposal_/);
    assert.equal(requests[2].body.ownerUserId, undefined);
  });
});
