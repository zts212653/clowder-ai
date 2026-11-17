import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { headers, matterCallbackFixture } from './helpers/matter-callback-fixture.js';

describe('F332 lightweight matter writing through remember', () => {
  let app, evidenceStore, messageStore, threadStore, threadA, threadB, credentials, original;
  beforeEach(async () => {
    ({ app, evidenceStore, messageStore, threadStore, threadA, threadB, credentials, original } =
      await matterCallbackFixture());
  });
  afterEach(async () => {
    await app.close();
    await evidenceStore.close();
  });
  it('one remember writes a summary with the real invocation source and another cat reads its author', async () => {
    credentials.get('call-a').originTriggerMessageId = original.id;
    const payload = {
      clientRequestId: 'light-summary',
      items: [
        {
          itemId: 'one',
          target: 'matter',
          payload: {
            operation: 'create',
            title: 'Settings',
            summary: '设置沿用已有入口，后续可回讨论核对。',
          },
        },
      ],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/remember',
      headers: headers('call-a'),
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json().results[0];
    assert.equal(result.statusCode, 201, JSON.stringify(result));
    const read = await app.inject({
      url: `/api/callbacks/memory-matters/${result.result.matter.matterId}`,
      headers: headers('call-b'),
    });
    assert.equal(read.statusCode, 200, read.body);
    const page = read.json(),
      entry = page.entries[0];
    assert.equal(entry.summary, payload.items[0].payload.summary);
    assert.deepEqual(entry.summaryAuthor, { kind: 'agent', catId: 'codex-astra' });
    assert.deepEqual(page.matter.descriptionAuthor, entry.summaryAuthor);
    assert.equal(entry.source.messageId, original.id);
    assert.equal(entry.source.origin, 'invocation');
    assert.deepEqual(entry.source.author, { kind: 'user', userId: 'owner-a' });
    assert.deepEqual(entry.readRef, {
      kind: 'message',
      threadId: threadA.id,
      messageId: original.id,
      expectedRevision: entry.source.contentRevision,
    });
    assert.equal(entry.quote, undefined, 'A summary must never be projected as exact original words');
    const events = evidenceStore.getDb().prepare('SELECT * FROM memory_cue_events').all();
    assert.equal(events.length, 2);
    const detail = JSON.parse(events[0].read_details_json).entries[0];
    assert.equal(typeof detail.entryRevision, 'string');
    assert.equal(detail.sourceRevision, undefined, 'Reading a summary is not reading its source');
    const ownerCue = await app.inject({
      url: `/api/threads/${threadB.id}/invocations/call-b/memory-cues`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.equal(ownerCue.statusCode, 200, ownerCue.body);
    assert.equal(ownerCue.json().cues[0].matterRead.messageCount, 0);
    assert.equal(ownerCue.json().cues[0].matterRead.summaryCount, 1);
    const originalRead = await app.inject({
      url: `/api/callbacks/get-message?messageId=${entry.readRef.messageId}&mode=full&memoryRead=true`,
      headers: headers('call-b'),
    });
    assert.equal(originalRead.statusCode, 200, originalRead.body);
    assert.equal(originalRead.json().message.content, original.content);
    assert.equal(originalRead.json().message.contentRevision, entry.readRef.expectedRevision);
    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/remember',
      headers: headers('call-a'),
      payload,
    });
    assert.deepEqual(retry.json().results[0].result, result.result);
  });

  it('thread-only summaries remain visible and append/correct without any selected quotation', async () => {
    const write = (payload, call = 'call-a') =>
      app.inject({ method: 'POST', url: '/api/callbacks/memory-matters/write', headers: headers(call), payload });
    const created = await write({
      operation: 'create',
      requestId: 'thread-only',
      title: 'Thread note',
      summary: '这是猫的归纳。',
      sources: [{ threadId: threadA.id }],
    });
    assert.equal(created.statusCode, 201, created.body);
    const { matterId } = created.json().matter;
    const first = (
      await app.inject({ url: `/api/callbacks/memory-matters/${matterId}`, headers: headers('call-b') })
    ).json();
    assert.equal(first.entries[0].sourceStatus, 'thread_only');
    assert.equal(first.entries[0].source.messageId, undefined);
    assert.equal(first.entries[0].source.sourceRevision, undefined);
    assert.equal(first.entries[0].readRef, undefined);
    assert.equal(first.summaryStatus, undefined);
    const catalog = (await app.inject({ url: '/api/callbacks/memory-matters', headers: headers('call-a') })).json();
    assert.equal(catalog.items[0].hasThreadSource, true);
    assert.equal(catalog.items[0].description, '这是猫的归纳。');
    const appended = await write(
      {
        operation: 'append',
        requestId: 'append-summary',
        matterId,
        expectedRevision: 1,
        summary: '另一只猫补了背景。',
      },
      'call-b',
    );
    assert.equal(appended.statusCode, 200, appended.body);
    const corrected = await write({
      operation: 'correct',
      requestId: 'correct-summary',
      matterId,
      expectedRevision: 2,
      entryId: first.entries[0].entryId,
      summary: '更正后的归纳。',
      source: { threadId: threadA.id },
    });
    assert.equal(corrected.statusCode, 200, corrected.body);
    const final = (
      await app.inject({ url: `/api/callbacks/memory-matters/${matterId}?history=true`, headers: headers('call-b') })
    ).json();
    assert.equal(final.matter.revision, 3);
    assert.equal(
      final.matter.description,
      '更正后的归纳。',
      'The directory must not keep the superseded initial summary',
    );
    assert.equal(final.entries.find((e) => e.summary === '这是猫的归纳。').status, 'superseded');
    assert.deepEqual(final.entries.find((e) => e.summary === '另一只猫补了背景。').summaryAuthor, {
      kind: 'agent',
      catId: 'codex61-sol',
    });
    assert.equal(final.entries.filter((e) => e.status === 'active').length, 2);
  });

  it('defaults only to confirmed invocation sources, preserves cat speakers and rejects forged writer/source fields', async () => {
    const trigger = messageStore.append({
      from: { kind: 'agent', catId: 'codex61-sol' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: '这是队友的建议。',
      mentions: [],
      timestamp: 3000,
    });
    credentials.get('call-a').originTriggerMessageId = trigger.id;
    const write = (payload) =>
      app.inject({ method: 'POST', url: '/api/callbacks/memory-matters/write', headers: headers('call-a'), payload });
    const base = {
      operation: 'create',
      requestId: 'cat-trigger',
      title: 'Cat source',
      summary: '我的归纳，不是人类原话。',
    };
    const created = await write(base);
    assert.equal(created.statusCode, 201, created.body);
    const read = async (result) =>
      (
        await app.inject({
          url: `/api/callbacks/memory-matters/${result.json().matter.matterId}`,
          headers: headers('call-b'),
        })
      ).json();
    const catPage = await read(created);
    assert.deepEqual(catPage.entries[0].source.author, { kind: 'agent', catId: 'codex61-sol' });
    assert.deepEqual(catPage.entries[0].summaryAuthor, { kind: 'agent', catId: 'codex-astra' });
    const system = messageStore.append({
      from: { kind: 'system', service: 'scheduler' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: '一次系统唤醒。',
      mentions: [],
      timestamp: 3500,
    });
    credentials.get('call-a').originTriggerMessageId = system.id;
    const systemResult = await write({ ...base, requestId: 'system-trigger' });
    assert.equal(systemResult.statusCode, 201, systemResult.body);
    assert.deepEqual(
      (await read(systemResult)).entries[0].source,
      { kind: 'thread', threadId: threadA.id, origin: 'invocation' },
      'An internal non-quotable system trigger falls back to the actual thread, never a human attribution',
    );
    const recalled = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: '撤回的输入',
      mentions: [],
      timestamp: 4500,
      deliveryStatus: 'queued',
    });
    const recall = messageStore.recallMessageToComposerDraft(recalled.id, {
      ownerUserId: 'owner-a',
      threadId: threadA.id,
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 6000,
    });
    assert.equal(recall.kind, 'recalled');
    for (const origin of [undefined, 'missing-message', recalled.id]) {
      credentials.get('call-a').originTriggerMessageId = origin;
      const result = await write({ ...base, requestId: `fallback-${origin}` });
      assert.equal(result.statusCode, 201, result.body);
      const page = await read(result);
      assert.deepEqual(page.entries[0].source, { kind: 'thread', threadId: threadA.id, origin: 'invocation' });
    }
    for (const forged of [
      { summaryAuthor: { kind: 'user', userId: 'owner-a' } },
      { invocation: { threadId: threadB.id } },
    ])
      assert.equal((await write({ ...base, requestId: 'forged-light', ...forged })).statusCode, 400);
    const foreign = threadStore.create('owner-b', 'Foreign');
    const hidden = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: 'Hidden',
      mentions: [],
      timestamp: 4000,
      visibility: 'whisper',
      whisperTo: ['codex61-sol'],
    });
    for (const pointer of [
      { threadId: foreign.id },
      { threadId: 'missing' },
      { threadId: threadA.id, messageId: hidden.id },
      { threadId: threadA.id, messageId: 'missing' },
    ]) {
      const denied = await write({ ...base, requestId: JSON.stringify(pointer), sources: [pointer] });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.json().reason, undefined);
    }
  });

  it('explains optional-quotation block, attachment, range and text errors only after source authorization', async () => {
    const attachment = {
      v: 1,
      id: 'quoted',
      kind: 'quote',
      text: '原引文',
      comment: '给这句话的批注',
      source: { kind: 'message', threadId: threadA.id, messageId: original.id },
    };
    const outer = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: '正文',
      contentBlocks: [
        { type: 'text', text: '正文' },
        { type: 'context_attachment', attachment },
      ],
      mentions: [],
      timestamp: 5000,
    });
    const selected = {
      threadId: threadA.id,
      messageId: outer.id,
      segment: 'quote_comment',
      contentBlockIndex: 1,
      attachmentId: 'quoted',
      start: 0,
      end: attachment.comment.length,
      quote: attachment.comment,
    };
    for (const [reason, patch] of [
      ['content_block', { contentBlockIndex: 0 }],
      ['attachment', { attachmentId: 'wrong' }],
      ['range', { end: 999 }],
      ['quote_mismatch', { quote: '编的' }],
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-matters/write',
        headers: headers('call-a'),
        payload: {
          operation: 'create',
          requestId: reason,
          title: 'Optional quotation',
          sources: [{ ...selected, ...patch }],
        },
      });
      assert.equal(result.statusCode, 400, result.body);
      assert.equal(result.json().error, 'invalid_source');
      assert.equal(result.json().reason, reason);
      assert.ok(result.json().message.length > 30);
    }
    const privateSource = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: '不可读的来源',
      mentions: [],
      timestamp: 5100,
      visibility: 'whisper',
      whisperTo: ['codex61-sol'],
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers('call-a'),
      payload: {
        operation: 'create',
        requestId: 'private-quotation',
        title: 'No leak',
        sources: [{ ...selected, messageId: privateSource.id, contentBlockIndex: 0 }],
      },
    });
    assert.equal(denied.statusCode, 404, denied.body);
    assert.equal(
      denied.json().reason,
      undefined,
      'Selection diagnostics must follow current source permission, never expose a private source',
    );
    const valid = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers('call-a'),
      payload: { operation: 'create', requestId: 'valid-optional', title: 'Optional quotation', sources: [selected] },
    });
    assert.equal(valid.statusCode, 201, valid.body);
  });
});
