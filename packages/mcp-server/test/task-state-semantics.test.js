// F332 / #1087: what Task state means when a cat resumes work, checked where the model reads it — the
// real MCP tools/list boundary. These anchors cover distinct meanings (ended state, saved why, the two
// resume branches, writer guidance); they prove delivery of the contract, not that a model will follow it.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('Task state semantics at the real MCP boundary', () => {
  let server;
  let client;
  let originalEnv;
  let tools;

  before(async () => {
    originalEnv = { ...process.env };
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-task-state-semantics';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-task-state-semantics';
    process.env.CAT_CAFE_READONLY = 'false';
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    const { createServer } = await import('../dist/index.js');
    server = createServer();
    client = new Client({ name: 'task-state-semantics-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    ({ tools } = await client.listTools());
  });

  after(async () => {
    await client.close();
    await server.close();
    process.env = originalEnv;
  });

  const tool = (name) => {
    const found = tools.find((entry) => entry.name === name);
    assert.ok(found, `${name} must be exported`);
    return found;
  };

  test('list_tasks tells the reader what an ended Task, its why and a generic resume mean', () => {
    const { description } = tool('cat_cafe_list_tasks');
    assert.match(description, /done records ended work, not proof that every artifact is complete/);
    assert.match(
      description,
      /why is saved task context[^.]*neither new authorization nor a guaranteed latest instruction/,
    );
    assert.match(
      description,
      /generic resume only identifies ended work[^.]*explicit authorization before further writes/,
    );
    assert.match(description, /explicit redo or extension request already authorizes new work within its scope/);
  });

  test('create_task and update_task explain why as saved context and ask for the ending of ordinary work', () => {
    // create_task is a governance migration candidate: its schema stays the protected base, so the
    // saved-context note travels in the tool description's existing why tip.
    assert.match(
      tool('cat_cafe_create_task').description,
      /saved context does not authorize further work after the task ends/,
    );
    const create = tool('cat_cafe_create_task').inputSchema;
    const update = tool('cat_cafe_update_task').inputSchema;
    assert.match(update.properties.why.description, /how it ended/);
    assert.match(update.properties.why.description, /entrusted work keeps its typed closure/);
    for (const schema of [create, update]) {
      assert.ok(!(schema.required ?? []).includes('why'), 'why stays optional');
    }
  });
});
