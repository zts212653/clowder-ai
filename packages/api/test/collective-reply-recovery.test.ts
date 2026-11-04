import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  assertMessageFromConsistent,
  type StoredMessage,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { readPluginMessageExtra } from '../src/domains/messaging/envelope.js';
import { readCollectiveReplyRecoveryTarget } from '../src/routes/collective-reply-recovery-target.js';
import {
  BODY,
  CAT,
  OWNER,
  openRecoveryHarness,
  outputLayout,
  RESPONSE_ID,
  recoveryFixture,
  replaceFinalBody,
  SIGNATURE,
  SOURCE_ID,
  THREAD,
} from './helpers/collective-reply-recovery-fixture.js';

describe('Collective reply recovery', () => {
  it('extracts only the proven model-authored final body and excludes the Host signature', () => {
    const { source, response } = recoveryFixture();
    assert.doesNotThrow(() => assertMessageFromConsistent(source));
    assert.ok(readPluginMessageExtra(source));
    assert.equal(source.source, undefined);
    const target = readCollectiveReplyRecoveryTarget(source, response, OWNER, CAT);
    assert.equal(target.body, BODY);
    assert.equal(target.bodySha256, createHash('sha256').update(BODY, 'utf8').digest('hex'));
    assert.equal(target.responseMessageId, RESPONSE_ID);
    assert.doesNotMatch(target.body, /gpt-6\.1-sol/);
  });

  it('keeps legacy external Collective rows recoverable through the same normalized source boundary', () => {
    const { source, response } = recoveryFixture();
    const presentation = source.extra?.pluginMessage?.presentation;
    assert.ok(presentation);
    source.from = { kind: 'external', connectorId: 'collective' };
    source.source = presentation;
    source.extra = undefined;
    const target = readCollectiveReplyRecoveryTarget(source, response, OWNER, CAT);
    assert.equal(target.body, BODY);
  });

  it('projects recoverability from the authoritative stored turn without queue effects', async () => {
    const harness = await openRecoveryHarness();
    try {
      const result = await harness.probe();
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json(), {
        status: 'recoverable',
        sourceMessageId: SOURCE_ID,
        responseMessageId: RESPONSE_ID,
      });
      assert.equal(harness.queue.list(THREAD, OWNER).length, 0);
      assert.equal(harness.requestDrain.mock.callCount(), 0);
    } finally {
      await harness.app.close();
    }
  });

  it('preserves whitespace inside the proven final boundary instead of rewriting the reply', () => {
    const { source, response } = recoveryFixture();
    const exactBody = `  ${BODY}\n`;
    response.content = `${exactBody}\n\n${SIGNATURE}`;
    const layout = outputLayout(response);
    layout.contentRevision = {
      length: response.content.length,
      sha256: createHash('sha256').update(response.content, 'utf8').digest('hex'),
    };
    layout.runs[0] = { ...layout.runs[0], end: exactBody.length };
    layout.hostTail = {
      ...layout.hostTail,
      start: exactBody.length,
      end: response.content.length,
      gluePrefixLength: 2,
    };
    const target = readCollectiveReplyRecoveryTarget(source, response, OWNER, CAT);
    assert.equal(target.body, exactBody);
  });

  it('excludes a proven glue prefix without trimming the model final', () => {
    const { source, response } = recoveryFixture();
    replaceFinalBody(response, BODY, '\n');
    const target = readCollectiveReplyRecoveryTarget(source, response, OWNER, CAT);
    assert.equal(target.body, BODY);
  });

  it('rejects an equal-length changed body instead of trusting stale layout evidence', () => {
    const { source, response } = recoveryFixture();
    response.content = `喵${response.content.slice(1)}`;
    assert.throws(() => readCollectiveReplyRecoveryTarget(source, response, OWNER, CAT), {
      code: 'COLLECTIVE_REPLY_RECOVERY_OUTPUT_UNAVAILABLE',
    });
  });

  it('queues one private same-source recovery turn and replays the exact request id', async () => {
    const harness = await openRecoveryHarness();
    try {
      const first = await harness.post();
      assert.equal(first.statusCode, 202, first.body);
      const [entry] = harness.queue.list(THREAD, OWNER);
      assert.ok(entry);
      assert.equal(entry.kind, 'private_input');
      assert.deepEqual(entry.targets, [CAT]);
      assert.equal(entry.execution.a2aTriggerMessageId, SOURCE_ID);
      assert.equal(entry.execution.suggestedSkill, 'collective-participation');
      assert.match(entry.payload.content, new RegExp(BODY));
      assert.doesNotMatch(entry.payload.content, /gpt-6\.1-sol/);

      const replay = await harness.post();
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(harness.queue.list(THREAD, OWNER).length, 1);
    } finally {
      await harness.app.close();
    }
  });

  it('refuses another owner, another cat and a non-completed local response before queue effects', async () => {
    const harness = await openRecoveryHarness({
      mutate: ({ response }) => {
        response.lifecycle = { ...response.lifecycle, status: 'failed' } as StoredMessage['lifecycle'];
      },
    });
    try {
      assert.equal((await harness.post({ owner: 'other' })).statusCode, 404);
      assert.equal((await harness.post({ catId: 'opus' })).statusCode, 409);
      assert.equal((await harness.post()).statusCode, 409);
      assert.equal(harness.queue.list(THREAD, OWNER).length, 0);
    } finally {
      await harness.app.close();
    }
  });

  it('keeps mention-like reply text on the exact original target', async () => {
    const harness = await openRecoveryHarness({
      mutate: ({ response }) => replaceFinalBody(response, `${BODY}\n@opus`),
    });
    try {
      const result = await harness.post();
      assert.equal(result.statusCode, 202, result.body);
      assert.deepEqual(harness.queue.list(THREAD, OWNER)[0]?.targets, [CAT]);
    } finally {
      await harness.app.close();
    }
  });

  it('uses requestId as the retry boundary', async () => {
    const harness = await openRecoveryHarness();
    try {
      assert.equal((await harness.post()).statusCode, 202);
      assert.equal((await harness.post()).statusCode, 202);
      assert.equal(harness.queue.list(THREAD, OWNER).length, 1);
      assert.equal((await harness.post({ requestId: '22222222-2222-4222-8222-222222222222' })).statusCode, 202);
      assert.equal(harness.queue.list(THREAD, OWNER).length, 2);
    } finally {
      await harness.app.close();
    }
  });
});
