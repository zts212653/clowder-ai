import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { CANONICAL_TOOL_REGISTRY } from '../dist/canonical-server-tools.js';

let savedEnv, savedFetch, requests, reply;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  requests = [];
  reply = {};
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  delete process.env.CAT_CAFE_DESKTOP_MODE;
  delete process.env.CAT_CAFE_READONLY;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'memory-test';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'memory-token';
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(url), init });
    return { ok: true, json: async () => reply };
  };
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function tool() {
  const result = CANONICAL_TOOL_REGISTRY.find((item) => item.name === 'cat_cafe_read_memory');
  assert.ok(result, 'production catalog must expose the unified memory reader');
  return result;
}
async function read(ref) {
  const result = await tool().handler(z.object(tool().inputSchema).parse({ ref }));
  return { result, body: JSON.parse(result.content[0].text) };
}

test('lightweight matter summaries preserve authors and thread-only provenance without inventing a message reader', async () => {
  reply = {
    matter: {
      matterId: 'matter-light',
      revision: 2,
      description: '归纳',
      descriptionAuthor: { kind: 'agent', catId: 'codex61-sol' },
    },
    entries: [
      {
        entryId: 'thread',
        summary: '只知道对话',
        summaryAuthor: { kind: 'agent', catId: 'codex61-sol' },
        sourceStatus: 'thread_only',
        source: { kind: 'thread', threadId: 'thread-real', origin: 'invocation' },
      },
      {
        entryId: 'message',
        summary: '知道消息',
        source: {
          kind: 'message',
          threadId: 'thread-real',
          messageId: 'message-real',
          sourceRevision: 'raw-hash',
          contentRevision: 'citation-hash',
        },
        readRef: {
          kind: 'message',
          threadId: 'thread-real',
          messageId: 'message-real',
          expectedRevision: 'citation-hash',
        },
      },
    ],
  };
  const { body } = await read({ kind: 'matter', matterId: 'matter-light' });
  assert.equal(body.status, 'ok');
  assert.equal(body.contentKind, 'cat_summary');
  assert.deepEqual(body.sourceThreads, [{ threadId: 'thread-real' }]);
  assert.deepEqual(body.sources, [
    { kind: 'message', threadId: 'thread-real', messageId: 'message-real', expectedRevision: 'citation-hash' },
  ]);
  assert.deepEqual(body.data.entries[0].summaryAuthor, { kind: 'agent', catId: 'codex61-sol' });
  assert.equal(body.data.entries[0].quote, undefined);
  assert.equal(requests.length, 1);
});

test('a current profile ref opens every original layer in one owner-authenticated read', async () => {
  for (const layer of ['primer', 'corpus', 'capsule']) {
    const revision = `sha256:${'a'.repeat(64)}`;
    reply = { layer, revision, content: 'approved current view' };
    const { body } = await read({ kind: 'profile', layer, expectedRevision: revision, requestId: 'same-retry' });
    assert.equal(body.status, 'ok');
    assert.equal(body.contentKind, 'approved_view');
    assert.equal(body.data.content, reply.content);
    assert.equal(requests.at(-1).url.pathname, '/api/callbacks/profile');
    assert.equal(requests.at(-1).url.searchParams.get('requestId'), 'same-retry');
    assert.equal(requests.at(-1).url.searchParams.get('expectedRevision'), revision);
    assert.equal(requests.at(-1).url.searchParams.get('layer'), layer);
  }
  assert.equal(requests.length, 3);
});

test('matter pagination and exact original sources are complete refs, preserving interpretation status', async () => {
  reply = {
    matter: { matterId: 'one', revision: 4, description: 'cat interpretation' },
    summaryStatus: 'sources_changed',
    entries: [
      { source: { threadId: 'thread', messageId: 'original', sourceRevision: 'r1' }, attribution: 'quoted_in_message' },
    ],
    nextCursor: 'owner-version-bound-cursor',
  };
  const { body } = await read({ kind: 'matter', matterId: 'one', expectedRevision: 4, limit: 2, history: true });
  assert.equal(body.status, 'source_changed');
  assert.equal(body.contentKind, 'mixed');
  assert.equal(body.data.summaryStatus, 'sources_changed');
  assert.deepEqual(body.sources, [{ kind: 'message', threadId: 'thread', messageId: 'original' }]);
  assert.equal(body.nextRef.cursor, reply.nextCursor);
  assert.equal(body.nextRef.expectedRevision, 4);
  assert.equal(body.nextRef.history, true);
  await read(body.nextRef);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get('cursor'), reply.nextCursor);
});

test('an exact message ref preserves citation facts, refuses a different thread and excludes queued reads', async () => {
  reply = {
    message: {
      id: 'original',
      threadId: 'thread',
      content: 'original words',
      contentRevision: 'r1',
      sourceParts: [{ part: { kind: 'body' }, length: 14 }],
    },
  };
  const { body } = await read({ kind: 'message', messageId: 'original', threadId: 'thread', expectedRevision: 'r1' });
  assert.equal(body.data.message.contentRevision, 'r1');
  assert.deepEqual(body.data.message.sourceParts, reply.message.sourceParts);
  assert.equal(requests[0].url.searchParams.get('memoryRead'), 'true');
  const wrong = await read({ kind: 'message', messageId: 'original', threadId: 'elsewhere' });
  assert.equal(wrong.body.status, 'not_available');
  assert.equal(wrong.body.data, undefined);
});

test('cue continuation retains its scoped handle, original retry and window; never settles adoption', async () => {
  reply = {
    status: 'ok',
    source: { family: 'evidence', revision: 'rev' },
    payload: {
      sourcePath: 'original.md',
      sourceRevision: 'rev',
      content: 'first',
      nextOffset: 4000,
      contentTruncated: true,
    },
  };
  const { body } = await read({
    kind: 'cue',
    handle: 'signed-current-handle',
    expectedRevision: 'rev',
    clientRequestId: 'retry',
  });
  assert.equal(body.nextRef.handle, 'signed-current-handle');
  assert.equal(body.nextRef.window.offset, 4000);
  assert.equal(body.nextRef.clientRequestId, undefined, 'a different window needs a different original request key');
  const sent = JSON.parse(requests[0].init.body);
  assert.equal(sent.requestId, 'retry');
  assert.equal(sent.expectedRevision, 'rev', 'check the ref version before the original drill commits its receipt');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url.pathname, /memory-cues\/drill$/);
});

test('cue person-card provenance and approved profile openings retain complete original refs', async () => {
  const source = { threadId: 'source-thread', messageId: 'source-message' };
  const opening = `---\nopening:\n  asOf: '2026-11-15'\n  excerpts:\n    - kind: relationship\n      text: approved excerpt\n      source:\n        threadId: source-thread\n        messageId: source-message\n---\nApproved body`;
  for (const payload of [
    { claim: 'cat summary', provenanceRefs: [source] },
    { profileUri: 'cat-cafe-profile://relationship/current', content: opening },
  ]) {
    reply = { status: 'ok', source: { revision: 'rev' }, payload };
    const { body } = await read({ kind: 'cue', handle: 'scoped', expectedRevision: 'rev' });
    assert.deepEqual(body.sources, [{ kind: 'message', ...source }]);
    assert.equal(body.sourcesStatus, 'available');
    reply = {
      message: { id: source.messageId, threadId: source.threadId, content: 'Original words.', contentRevision: 'm1' },
    };
    assert.equal((await read(body.sources[0])).body.data.message.content, 'Original words.');
  }
  assert.equal(requests.length, 4, 'each cue → original journey takes the original two calls, without a ref lookup');
});

test('readonly and cloud profiles cannot acquire full-only matter/cue or local-file access', async () => {
  process.env.CAT_CAFE_READONLY = 'true';
  for (const ref of [
    { kind: 'matter', matterId: 'one' },
    { kind: 'cue', handle: 'handle' },
    { kind: 'profile', layer: 'corpus' },
  ]) {
    assert.equal((await read(ref)).body.status, 'not_available');
  }
  process.env.CAT_CAFE_DESKTOP_MODE = 'cloud-pro-phase0';
  for (const ref of [
    { kind: 'matter', matterId: 'one' },
    { kind: 'cue', handle: 'handle' },
    { kind: 'file', path: '/private/owner.txt', startLine: 1 },
  ]) {
    assert.equal((await read(ref)).body.status, 'not_available');
  }
  assert.equal(requests.length, 0, 'denied branches do not touch a reader');
});

test('ref schema is closed: no arbitrary tool dispatch, foreign profile or mixed source selectors', () => {
  const schema = z.object(tool().inputSchema);
  for (const ref of [
    { kind: 'tool', toolName: 'cat_cafe_remember', params: {} },
    { kind: 'profile', layer: 'corpus', userId: 'foreign' },
    { kind: 'matter', matterId: 'one', path: '/other' },
    { kind: 'cue', handle: 'signed', window: { offset: 1, query: 'both' } },
  ])
    assert.equal(schema.safeParse({ ref }).success, false);
});

test('a long original preserves the original one-call full read without truncation or extra pagination', async () => {
  const original = {
    message: {
      id: 'long',
      threadId: 't',
      content: '🐈原话\n'.repeat(16000),
      contentRevision: 'original-r1',
      sourceParts: [{ part: { kind: 'body' }, length: 96000 }],
    },
  };
  reply = original;
  const { result, body } = await read({ kind: 'message', messageId: 'long', threadId: 't' });
  assert.equal(requests.length, 1, 'same original source, identity and full range take one original callback');
  assert.equal(body.complete, true, 'unified reading must not turn one full read into several MCP calls');
  assert.equal(body.nextRef, undefined);
  assert.equal(body.version, 'original-r1');
  assert.ok(body.data.contentBlocks.length > 1);
  const serialized = body.data.contentBlocks.map((index) => result.content[index].text).join('');
  assert.deepEqual(JSON.parse(serialized), original, 'all original fields and citation parts are in this response');
  assert.ok(result.content.every((block) => block.text.length <= 23000));
  reply = { message: { ...original.message, content: 'corrected', contentRevision: 'r2' } };
  const changed = await read(body.ref);
  assert.equal(changed.body.status, 'source_changed');
  assert.equal(changed.body.data, undefined);
  assert.equal(changed.body.retryRef, undefined);
});

test('file refs reuse the real bounded reader, resume a long line and refuse changed sources', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-reader-'));
  try {
    process.env.ALLOWED_WORKSPACE_DIRS = directory;
    const path = join(directory, 'original.md');
    const line = 'a'.repeat(25000);
    writeFileSync(path, line + '\nthe next line');
    const first = await read({ kind: 'file', path, startLine: 1 });
    assert.equal(first.body.complete, false);
    assert.equal(first.body.nextRef.kind, 'file');
    assert.equal(first.body.nextRef.startLine, 1);
    assert.ok(first.body.nextRef.charOffset > 0);
    const last = await read(first.body.nextRef);
    assert.equal(last.body.complete, true);
    assert.match(last.result.content[last.body.data.contentBlock].text, /the next line/);
    writeFileSync(path, 'changed');
    const changed = await read(first.body.nextRef);
    assert.equal(changed.body.status, 'source_changed');
    assert.equal(changed.body.data, undefined);
    assert.equal(changed.body.error.retryable, false);
    const denied = await read({ kind: 'file', path: join(directory, '..', 'private.txt'), startLine: 1 });
    assert.equal(denied.body.status, 'not_available');
    assert.equal(requests.length, 0);
    writeFileSync(path, '"'.repeat(18000));
    const quoted = await read({ kind: 'file', path, startLine: 1 });
    assert.equal(quoted.body.complete, true, 'JSON escaping must not add a read call to the original file journey');
    assert.ok(quoted.result.content[quoted.body.data.contentBlock].text.includes('"'.repeat(18000)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown receipt outcomes keep the exact profile/cue retry keys and original error', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: 'read_commit_failed', retryable: true }),
  });
  for (const ref of [
    { kind: 'profile', layer: 'capsule' },
    { kind: 'cue', handle: 'scoped' },
  ]) {
    const { body } = await read(ref);
    assert.equal(body.error.retryable, true);
    assert.match(body.error.reason, /read_commit_failed/);
    assert.ok(body.retryRef.requestId || body.retryRef.clientRequestId);
    const retried = await read(body.retryRef);
    assert.deepEqual(retried.body.retryRef, body.retryRef);
  }
});
