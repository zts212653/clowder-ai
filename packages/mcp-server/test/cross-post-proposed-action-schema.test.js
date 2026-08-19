import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F246 proposedAction tools/list contract', () => {
  test('publishes the two executable approval variants inline', async () => {
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
      assert.ok(Array.isArray(proposedAction.anyOf), 'proposedAction must expose a concrete discriminated union');
      assert.match(proposedAction.description, /review \+ reviewer \+ review_delivered/);
      assert.match(proposedAction.description, /implement \+ implementer \+ task_done/);
      assert.match(proposedAction.description, /subject:task:<taskId>/);

      const variants = proposedAction.anyOf.map((branch) => ({
        actionFamily: branch.properties.actionFamily.const,
        successorSlot: branch.properties.successorSlot.const,
        predicateKind: branch.properties.terminalPredicate.properties.kind.const,
        subjectPattern: branch.properties.subjectRef.pattern,
      }));
      assert.deepEqual(variants, [
        {
          actionFamily: 'review',
          successorSlot: 'reviewer',
          predicateKind: 'review_delivered',
          subjectPattern: '^pr:[^/\\s]+\\/[^#\\s]+#[1-9]\\d*$',
        },
        {
          actionFamily: 'implement',
          successorSlot: 'implementer',
          predicateKind: 'task_done',
          subjectPattern: '^subject:task:[^\\s\\x1f]{1,200}$',
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
