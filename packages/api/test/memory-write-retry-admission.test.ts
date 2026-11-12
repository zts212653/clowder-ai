import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendSchedulerWakeRow } from './approval-hub/scheduler-origin-callback-fixtures.js';

import { memoryRetryFixture as fixture } from './helpers/memory-write-retry-fixture.js';

for (const kind of ['entity', 'event'] as const) {
  test(
    `${kind}: real MCP entry publishes one original card and exposes retry conflicts`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(kind);
      const root = await mkdtemp(join(tmpdir(), 'm3-original-mcp-'));
      const client = new Client({ name: 'm3-original-request', version: '1.0.0' });
      t.after(async () => {
        await client.close();
        await f.app.close();
        await rm(root, { recursive: true, force: true });
      });
      const auth = await f.auth();
      const api = await f.app.listen({ port: 0, host: '127.0.0.1' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('../mcp-server/dist/index.js')],
        cwd: resolve('../..'),
        env: {
          PATH: process.env.PATH,
          CAT_CAFE_API_URL: api,
          CAT_CAFE_INVOCATION_ID: auth.invocationId,
          CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
          CAT_CAFE_USER_ID: f.owner,
          CAT_CAFE_CAT_ID: 'opus',
          CAT_CAFE_THREAD_ID: f.thread.id,
          CAT_CAFE_DATA_DIR: join(root, 'data'),
          CAT_CAFE_CALLBACK_OUTBOX_DIR: join(root, 'outbox'),
          CAT_CAFE_CALLBACK_RETRY_DELAYS_MS: '0,0',
        },
        stderr: 'pipe',
      });
      transport.stderr?.resume();
      await client.connect(transport);
      const name = kind === 'entity' ? 'cat_cafe_propose_entity' : 'cat_cafe_propose_event_memory_correction';
      const first = await client.callTool({ name, arguments: f.input });
      assert.notEqual(first.isError, true, JSON.stringify(first));
      const replay = await client.callTool({ name, arguments: f.input });
      assert.notEqual(replay.isError, true, JSON.stringify(replay));
      assert.ok(JSON.stringify(replay).includes('deduped'));
      assert.equal(
        f.messages.getByThread(f.thread.id, 100, f.owner).filter((message) => message.extra?.rich?.blocks.length)
          .length,
        1,
      );
      const changed =
        kind === 'entity'
          ? { ...f.input, rationale: 'Changed through the real MCP front door' }
          : { ...f.input, suggestedPatch: { summary: 'Changed through the real MCP front door' } };
      const conflict = await client.callTool({ name, arguments: changed });
      assert.equal(conflict.isError, true, JSON.stringify(conflict));
      assert.ok(JSON.stringify(conflict).includes('client_request_conflict'));
      await f.messages.softDelete(f.origin.id, f.owner);
      const withdrawn = await client.callTool({ name, arguments: f.input });
      assert.equal(withdrawn.isError, true, JSON.stringify(withdrawn));
      assert.ok(JSON.stringify(withdrawn).includes('origin_not_eligible'));
    },
  );

  test(`${kind}: reservation-loser recovery checks the same content as the cached branch`, async (t) => {
    const f = await fixture(kind);
    t.after(() => f.app.close());
    const auth = await f.auth();
    const first = await f.post(auth);
    assert.equal(first.statusCode, 200, first.body);
    f.store.getDedupProposalId = async () => null;
    const changed =
      kind === 'entity'
        ? { ...f.input, rationale: 'A different race loser' }
        : { ...f.input, suggestedPatch: { summary: 'A different race loser' } };
    const retry = await f.post(auth, changed);
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal(retry.json().error, 'client_request_conflict');
    const valid = await f.post(auth);
    assert.equal(valid.statusCode, 200, valid.body);
    assert.equal(valid.json().proposalId, first.json().proposalId);
  });

  test(`${kind}: recovery retains its catalogued scheduler and invocation-event origins`, async (t) => {
    for (const sourceKind of ['scheduler', 'event'] as const) {
      const f = await fixture(kind);
      t.after(() => f.app.close());
      const wake = sourceKind === 'scheduler' ? await appendSchedulerWakeRow(f.messages, f.thread.id) : null;
      const first = await f.post(await f.auth(wake));
      assert.equal(first.statusCode, 200, first.body);
      const saved = await f.get(first.json().proposalId);
      assert.equal(saved?.approvalOriginRef?.kind, sourceKind === 'scheduler' ? 'message' : 'event');
      const retry = await f.post(await f.auth());
      assert.equal(retry.statusCode, 200, retry.body);
      assert.deepEqual((await f.get(retry.json().proposalId))?.approvalOriginRef, saved?.approvalOriginRef);
    }
  });

  test(`${kind}: a failed envelope commit recovers the existing card and never republishes a changed request`, async (t) => {
    const f = await fixture(kind);
    t.after(() => f.app.close());
    const commit = f.store.commitEnvelope.bind(f.store);
    f.store.commitEnvelope = async () => {
      throw new Error('Interrupted after the card append');
    };
    const first = await f.post(await f.auth());
    assert.equal(first.statusCode, 500, first.body);
    const messagesBefore = f.messages.getByThread(f.thread.id, 100, f.owner);
    const cards = messagesBefore.filter((message) => message.extra?.rich?.blocks.length);
    assert.equal(cards.length, 1);
    const changed =
      kind === 'entity'
        ? { ...f.input, rationale: 'Changed while recovering' }
        : { ...f.input, suggestedPatch: { summary: 'Changed while recovering' } };
    assert.equal((await f.post(await f.auth(), changed)).statusCode, 409);
    f.store.commitEnvelope = commit;
    const retry = await f.post(await f.auth());
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().recovered, true);
    const saved = await f.get(retry.json().proposalId);
    assert.equal(saved?.publication?.state, 'anchored');
    assert.equal(
      f.messages.getByThread(f.thread.id, 100, f.owner).filter((message) => message.extra?.rich?.blocks.length).length,
      1,
    );
  });

  test(`${kind}: same retry key cannot accept changed proposal content`, async (t) => {
    const f = await fixture(kind);
    t.after(() => f.app.close());
    const auth = await f.auth();
    const first = await f.post(auth);
    assert.equal(first.statusCode, 200, first.body);
    const changed =
      kind === 'entity'
        ? { ...f.input, rationale: 'A different command' }
        : { ...f.input, suggestedPatch: { summary: 'A different command' } };
    const retried = await f.post(auth, changed);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal(retried.json().error, 'client_request_conflict');
    assert.equal((await f.get(first.json().proposalId))?.status, 'pending');
  });

  test(`${kind}: a deleted original source cannot be republished on retry`, async (t) => {
    const f = await fixture(kind);
    t.after(() => f.app.close());
    const firstAuth = await f.auth();
    const first = await f.post(firstAuth);
    assert.equal(first.statusCode, 200, first.body);
    await f.messages.softDelete(f.origin.id, f.owner);
    const next = f.messages.append({
      userId: f.owner,
      threadId: f.thread.id,
      from: { kind: 'user', userId: f.owner },
      content: 'Later unrelated message',
      timestamp: Date.now(),
    });
    const replay = await f.post(await f.auth(next));
    assert.equal(replay.statusCode, 409, replay.body);
    assert.equal(replay.json().error, 'origin_not_eligible');
  });

  test(`${kind}: another cat cannot recover the creator's request identity`, async (t) => {
    const f = await fixture(kind);
    t.after(() => f.app.close());
    const first = await f.post(await f.auth());
    assert.equal(first.statusCode, 200, first.body);
    const replay = await f.post(await f.auth(f.origin, 'sonnet'));
    assert.equal(replay.statusCode, 409, replay.body);
    assert.equal(replay.json().error, 'client_request_conflict');
  });

  test(`${kind}: the original request recovers across invocations without rebinding its origin`, async (t) => {
    const f = await fixture(kind);
    t.after(() => f.app.close());
    const first = await f.post(await f.auth());
    assert.equal(first.statusCode, 200, first.body);
    const next = f.messages.append({
      userId: f.owner,
      threadId: f.thread.id,
      from: { kind: 'user', userId: f.owner },
      content: 'Resume after lost response',
      timestamp: Date.now(),
    });
    const replay = await f.post(await f.auth(next));
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().proposalId, first.json().proposalId);
    assert.deepEqual((await f.get(first.json().proposalId))?.approvalOriginRef, {
      kind: 'message',
      threadId: f.thread.id,
      messageId: f.origin.id,
    });
  });
}
