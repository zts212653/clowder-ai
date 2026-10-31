import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const existingAction = {
  subjectRef: 'subject:task:task-fixture',
  actionFamily: 'implement',
  successorSlot: 'implementer',
  mode: 'single',
  claimOrigin: 'existing_standing',
  groundingEvidenceRef: 'message:authorized-source',
  terminalPredicate: { kind: 'task_done' },
};

describe('Task dispatch guidance at the real MCP boundary', () => {
  let server;
  let client;
  let originalEnv;
  let originalFetch;
  let callbackRequests;

  before(async () => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-dispatch-guidance';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-dispatch-guidance';
    process.env.CAT_CAFE_READONLY = 'false';
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    const { createServer } = await import('../dist/index.js');
    server = createServer();
    client = new Client({ name: 'task-dispatch-guidance-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  beforeEach(() => {
    callbackRequests = [];
    globalThis.fetch = async (_url, options) => {
      callbackRequests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
  });

  after(async () => {
    await client.close();
    await server.close();
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test('artifact identity plus missing predicate explains both repairs before any callback', async () => {
    // Same structural failure as the shared F329 evidence; project-specific work-package text stays at source.
    const { terminalPredicate: _, ...action } = existingAction;
    const result = await client.callTool({
      name: 'cat_cafe_cross_post_message',
      arguments: {
        threadId: 'thread_existing',
        targetCats: ['codex-sol'],
        content: 'Original work package',
        clientMessageId: 'wrong-artifact-subject',
        acceptedSourceRef: 'thread_original#authorized-source',
        acceptedRevision: 'authorized-source',
        action: { ...action, subjectRef: 'artifact:example/building-A/inputs-v1' },
      },
    });
    assert.equal(result.isError, true);
    const error = result.content[0].text;
    assert.match(error, /Input validation error/);
    assert.match(error, /subject:task:<taskId>/);
    assert.match(error, /asset|artifact/i);
    assert.match(error, /terminalPredicate/);
    assert.match(error, /task_done/);
    assert.match(error, /existing_standing/);
    assert.deepEqual(callbackRequests, []);
  });

  test('tools/list explains the conditional predicate and actual Task identity on every direct carrier', async () => {
    const { tools } = await client.listTools();
    for (const name of ['cat_cafe_post_message', 'cat_cafe_cross_post_message', 'cat_cafe_multi_mention']) {
      const tool = tools.find((entry) => entry.name === name);
      const action = tool.inputSchema.properties.action;
      assert.match(action.properties.subjectRef.description, /subject:task:<taskId>/);
      assert.match(action.properties.subjectRef.description, /existing Task/);
      const predicate = action.properties.terminalPredicate.description;
      assert.match(predicate, /Required.*new/i);
      assert.match(predicate, /existing_standing/);
      assert.match(predicate, /returnToPredecessor/);
    }
  });

  for (const name of ['cat_cafe_post_message', 'cat_cafe_cross_post_message']) {
    test(`${name} explains that review anchors cannot authorize implementation`, async () => {
      const result = await client.callTool({
        name,
        arguments: {
          ...(name === 'cat_cafe_cross_post_message' ? { threadId: 'thread_existing' } : {}),
          targetCats: ['codex-sol'],
          content: 'Original authorized Task work package',
          clientMessageId: 'wrong-review-fields',
          acceptedSourceRef: 'thread_original#authorized-source',
          acceptedRevision: 'authorized-source',
          action: existingAction,
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /localReviewVerdict/);
      assert.match(result.content[0].text, /not implementation authorization/i);
      assert.match(result.content[0].text, /content/);
      assert.deepEqual(callbackRequests, []);
    });
  }

  test('new claims still need a predicate; exact return remains the existing exception', async () => {
    const { executableActionSuccessorMetadataSchema } = await import('@cat-cafe/shared');
    const { terminalPredicate: _, ...withoutPredicate } = existingAction;
    assert.equal(executableActionSuccessorMetadataSchema.safeParse(existingAction).success, true);
    assert.equal(executableActionSuccessorMetadataSchema.safeParse(withoutPredicate).success, false);
    assert.equal(
      executableActionSuccessorMetadataSchema.safeParse({
        ...withoutPredicate,
        claimOrigin: 'structured_transfer',
        returnToPredecessor: {
          leaseId: 'lease-existing',
          expectedGeneration: 1,
          groundingEvidenceRef: 'message:rejected',
        },
      }).success,
      true,
    );
  });

  test('ordinary existing-owner notification still uses the original transport without manufacturing action authority', async () => {
    const result = await client.callTool({
      name: 'cat_cafe_cross_post_message',
      arguments: {
        threadId: 'thread_existing',
        targetCats: ['codex-sol'],
        effectClass: 'coordinate',
        content: 'Status evidence for your existing responsibility.',
      },
    });
    assert.notEqual(result.isError, true);
    assert.equal(callbackRequests.length, 1);
    assert.equal('action' in callbackRequests[0], false);
    assert.equal('proposedAction' in callbackRequests[0], false);
  });
});
