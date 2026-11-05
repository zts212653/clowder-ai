import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F246 proposedAction tools/list contract', () => {
  test('publishes the Task approval shape inline for invocation auth', async (t) => {
    const keys = ['CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];
    const original = new Map(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-proposed-action-schema';
    process.env.CAT_CAFE_CALLBACK_TOKEN = ['token', 'proposed', 'action', 'schema'].join('-');
    const [{ createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
      import('../dist/index.js'),
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
    ]);
    const server = createServer();
    const client = new Client({ name: 'f246-proposed-action-schema-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === 'cat_cafe_cross_post_message');
      assert.ok(tool, 'cross_post_message must be present in tools/list');

      const proposedAction = tool.inputSchema.properties.proposedAction;
      assert.equal('$ref' in proposedAction, false, 'proposedAction must not hide behind the generic action $ref');
      assert.equal(proposedAction.type, 'object');
      assert.doesNotMatch(JSON.stringify(proposedAction), /review_delivered/);
      assert.match(proposedAction.description, /implement \+ implementer \+ task_done/);
      assert.match(proposedAction.description, /subject:task:<taskId>/);

      assert.equal(proposedAction.properties.actionFamily.const, 'implement');
      assert.equal(proposedAction.properties.successorSlot.const, 'implementer');
      assert.equal(proposedAction.properties.terminalPredicate.properties.kind.const, 'task_done');
      assert.match(proposedAction.properties.subjectRef.pattern, /subject:task/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
