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

  // F332 S9 (attempt 15 on 821e72a2b without this branch; attempt 16 on 7da4d7b04 with its first wording delivered; both
  // finding P1): a generic resume over several unfinished works wrote to one of them without asking. The reader contract
  // states when that choice is still open and what settles it (spec AC-5 / AC-B10); the anchors follow the reviewer's
  // seven contract examples and keep the ended-work and explicit-request branches. They prove delivery, not behavior.
  test('list_tasks states when a choice between unfinished works is still open, what settles it, and keeps the direct branches', () => {
    const description = tool('cat_cafe_list_tasks').description;
    for (const anchor of [
      // 1. still open between unfinished works: ask by work name before any write
      'If a generic resume could still mean more than one unfinished work, ask which to continue by work name before any write.',
      // 2, 4. a current request that clearly refers to one work settles it
      'The choice is settled by a current request that clearly refers to one work',
      // 3. a newer explicit request or owner-record selection resolves an earlier open choice
      'by a newer explicit request or a newer explicit selection in the owner record',
      // 4, 5. one legitimately matching work proceeds even with unrelated unfinished work
      'or when only one work legitimately matches, even if unrelated unfinished work exists; that work proceeds under its current state and authorization.',
      // cues are insufficient alone, not banned
      'A doing status, a saved why that says to continue, an earlier request or artifact, the listing order or a stop-point link is only a cue: alone it does not settle a choice that is otherwise still open.',
      // unchanged: the unfinished-state definition, 6. ended work on a generic resume, 7. explicit redo or extension
      'todo/doing/blocked record unfinished work',
      'If a generic resume only identifies ended work',
      'an explicit redo or extension request already authorizes new work within its scope',
    ]) {
      assert.ok(description.includes(anchor), anchor);
    }
    // The first wording is replaced; the rejected narrowing to a thread-wide single unfinished work is not introduced.
    assert.ok(
      !description.includes('neither the current input nor the owner records settle which one this turn is for'),
    );
    assert.ok(!description.includes('the only unfinished work'));
  });
});
