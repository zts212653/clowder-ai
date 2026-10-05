import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCloudBridgeStatusContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { dispatchBoundConversationThroughHost } from '../dist/domains/cats/services/cloud-bridge/conversation-host-dispatch.js';
import { PersonalChromeHostAdapter } from '../dist/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js';
import { createNativeHostBridge } from '../src/plugins/cloud-cat-personal-host/native-host/native-host.mjs';

function diagnostic(errorCode, phase = 'failed_before_submit') {
  return {
    v: 1,
    errorCode,
    nextAction: 'inspect_bound_tab',
    fingerprint: {
      v: 1,
      phase,
      adapterRevision: '2026-09-19.1',
      artifactRevision: '0.2.12',
      nodes: [],
      truncated: false,
    },
  };
}
async function status(errorCode, failureDiagnostic) {
  const decision = await dispatchBoundConversationThroughHost({
    adapter: {
      append_message: async () => {
        throw Object.assign(new Error('private provider detail'), {
          code: errorCode,
          idempotentReplay: false,
          diagnostic: failureDiagnostic,
        });
      },
    },
    boundUrl: 'https://chatgpt.com/c/conversation-id',
    renderedPrompt: 'source',
    params: { sourceMessageId: 'source-id' },
  });
  return JSON.parse(
    buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome: decision.outcome,
      audit: {
        sourceMessageId: 'source-id',
        sourceSender: { kind: 'user', id: 'owner' },
        dispatchInvocationId: 'dispatch-1',
      },
    }),
  );
}

for (const code of ['SEND_BUTTON_NOT_FOUND', 'SEND_BUTTON_DISABLED', 'SEND_BUTTON_AMBIGUOUS', 'CHATGPT_GENERATING']) {
  test(`${code}: exact pre-submit failure is shown as unsent with a failed Host receipt`, async () => {
    const result = await status(code, diagnostic(code));
    assert.match(result.message, /^未发送给/);
    assert.equal(result.outboundReceipt.status, 'failed');
    assert.equal(result.outboundReceipt.transport, 'host');
    assert.equal(result.outboundReceipt.sourceMessageId, 'source-id');
    assert.equal(result.outboundReceipt.idempotency.disposition, 'fresh');
    assert.doesNotMatch(result.message, /private provider detail/);
    assert.match(result.message, /重新 @gpt-pro 发一条新消息/);
    assert.doesNotMatch(result.message, /重试/);
  });
}

test('same source replays the real terminal Host failure and asks for a new message', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-failed-replay-'));
  const paths = {
    socketPath: join(root, 'host.sock'),
    ledgerPath: join(root, 'ledger.json'),
    conversationBindingPath: join(root, 'binding.json'),
  };
  const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;
  const pairingSecret = 'a'.repeat(64);
  const boundUrl = 'https://chatgpt.com/c/conversation-7';
  let bridge;
  t.after(async () => {
    await bridge?.stop();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    paths.conversationBindingPath,
    JSON.stringify({
      schemaVersion: 1,
      provider: 'chatgpt',
      conversationId: 'conversation-7',
      chatUrl: boundUrl,
      boundAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );
  let nativeDispatches = 0;
  bridge = await createNativeHostBridge({
    ...paths,
    pairingSecret,
    helperArtifactRevision,
    sendNative: async (request) => {
      nativeDispatches++;
      await bridge.acceptNativeMessage({
        v: 2,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        observedRevisions: request.expectedRevisions,
        ...(nativeDispatches === 1
          ? { status: 'failed', errorCode: 'CHATGPT_GENERATING', diagnostic: diagnostic('CHATGPT_GENERATING') }
          : { status: 'host_observed', hostMessageId: 'new-message-host-id' }),
      });
    },
  });
  const adapter = new PersonalChromeHostAdapter({ ...paths, pairingSecret, helperArtifactRevision });
  const results = [];
  for (let turn = 0; turn < 2; turn++) {
    const decision = await dispatchBoundConversationThroughHost({
      adapter,
      boundUrl,
      renderedPrompt: 'same source text',
      params: { sourceMessageId: 'same-source' },
    });
    results.push(
      JSON.parse(
        buildCloudBridgeStatusContent({
          catId: 'gpt-pro',
          outcome: decision.outcome,
          audit: {
            sourceMessageId: 'same-source',
            sourceSender: { kind: 'user', id: 'owner' },
            dispatchInvocationId: `dispatch-${turn}`,
          },
        }),
      ),
    );
  }
  assert.equal(nativeDispatches, 1, 'same source must not touch the page again');
  assert.deepEqual(
    results.map((result) => result.outboundReceipt.idempotency.disposition),
    ['fresh', 'replayed'],
  );
  for (const result of results) {
    assert.equal(result.outboundReceipt.status, 'failed');
    assert.match(result.message, /重新 @gpt-pro 发一条新消息/);
    assert.doesNotMatch(result.message, /重试/);
  }
  const fresh = await dispatchBoundConversationThroughHost({
    adapter,
    boundUrl,
    renderedPrompt: 'same source text',
    params: { sourceMessageId: 'new-source' },
  });
  assert.equal(nativeDispatches, 2, 'a new source reaches the Native boundary after the page becomes idle');
  assert.equal(fresh.outcome.kind, 'sent');
  assert.equal(fresh.outcome.hostMessageId, 'new-message-host-id');
});
for (const [code, failure] of [
  ['SEND_BUTTON_NOT_FOUND', undefined],
  ['HOST_MESSAGE_NOT_OBSERVED', diagnostic('HOST_MESSAGE_NOT_OBSERVED')],
  ['HOST_TIMEOUT', undefined],
  ['SEND_BUTTON_NOT_FOUND', diagnostic('SEND_BUTTON_NOT_FOUND', 'after_submit')],
]) {
  test(`${code} without exact pre-submit proof remains unknown (${failure?.fingerprint.phase})`, async () => {
    const result = await status(code, failure);
    assert.match(result.message, /结果未知/);
    assert.equal(result.outboundReceipt.status, 'unknown');
  });
}
