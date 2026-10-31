import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createConfiguredJevPageProfile,
  pageConfigSchema,
} from '../src/domains/concierge/action/jev/ConfiguredJevPage.js';

const config = {
  profileId: 'owner-note',
  pageUrl: 'http://127.0.0.1:5261/',
  browserURL: 'http://127.0.0.1:5262',
  allowJevProjection: true as const,
  targets: [
    { id: 'note', selector: '#note', operation: 'fill' as const, expectedReadbackTemplate: '{value}' },
    { id: 'open', selector: '#open', operation: 'click' as const, expectedReadback: 'opened' },
  ],
  readback: { selector: '#note', kind: 'value' as const },
};
const snapshot = {
  origin: 'http://127.0.0.1:5261',
  url: config.pageUrl,
  readback: '',
  candidates: [
    { id: 'note', operation: 'fill' as const, label: '今日便签', fingerprint: 'current' },
    { id: 'open', operation: 'click' as const, label: '打开清单', fingerprint: 'open-current' },
  ],
};
const receipt = {
  requestId: 'request',
  providerRequestId: null,
  requestedModel: 'jev-latest' as const,
  servedModel: 'jev-1.13.0',
  inputSha256: 'hash',
  candidates: snapshot.candidates,
  choice: { kind: 'act' as const, targetId: 'note', operation: 'fill' as const, value: '带伞' },
  confidence: 0.9,
  elapsedMs: 20,
};

test('configured product consumes Jev and preserves the owner value; selected plan is reused only on the same live input and DOM', async () => {
  let calls = 0;
  const profile = createConfiguredJevPageProfile(config, {
    async select(input) {
      calls++;
      assert.equal(input.utterance, '填入「带伞」');
      assert.equal(input.candidates.length, 2);
      return { choice: receipt.choice, receipt };
    },
  });
  const signal = new AbortController().signal;
  const plan = await profile.prepare(snapshot, { utterance: '填入「带伞」', signal });
  assert.equal(plan.action.value, '带伞');
  assert.equal(plan.action.expectedReadback, '带伞');
  assert.equal(plan.selection?.servedModel, 'jev-1.13.0');
  assert.equal(plan.consent.restoreValue, undefined);
  assert.equal(profile.restoreAfterAction, false);
  const selector = profile.selector(plan.action);
  assert.deepEqual(
    await selector.select({ utterance: '填入「带伞」', candidates: snapshot.candidates, signal }),
    receipt.choice,
  );
  assert.equal(
    (await selector.select({ utterance: '改成「带水」', candidates: snapshot.candidates, signal })).kind,
    'none',
  );
  assert.equal(
    (
      await selector.select({
        utterance: '填入「带伞」',
        candidates: [{ ...snapshot.candidates[0], fingerprint: 'replaced' }],
        signal,
      })
    ).kind,
    'none',
  );
  assert.equal(calls, 1);
});

test('ASK, NONE, expired selection and ungranted target never make a consent', async () => {
  for (const choice of [
    { kind: 'ask', reason: '哪个？' },
    { kind: 'none', reason: '取消' },
  ] as const) {
    const profile = createConfiguredJevPageProfile(config, {
      async select() {
        return { choice, receipt: { ...receipt, choice } };
      },
    });
    await assert.rejects(
      profile.prepare(snapshot, { utterance: '处理它', signal: new AbortController().signal }),
      /哪个|取消/,
    );
  }
  const profile = createConfiguredJevPageProfile(config, {
    async select() {
      return { choice: { kind: 'act', targetId: 'delete', operation: 'click' }, receipt };
    },
  });
  await assert.rejects(profile.prepare(snapshot, { utterance: '打开清单', signal: new AbortController().signal }));
});

test('config requires explicit external projection and exact loopback endpoints; no daily/Alpha/Redis ports or ambiguous targets', () => {
  assert.equal(pageConfigSchema.safeParse(config).success, true);
  for (const patch of [
    { allowJevProjection: false },
    { pageUrl: 'https://private.example/' },
    { browserURL: 'http://127.0.0.1:3004' },
    { pageUrl: 'http://127.0.0.1:6399/' },
    { targets: [config.targets[0], config.targets[0]] },
    { readback: { selector: 'body', kind: 'text' } },
    { pageUrl: 'http://user:password@127.0.0.1:5261/' },
  ])
    assert.equal(pageConfigSchema.safeParse({ ...config, ...patch }).success, false);
});
