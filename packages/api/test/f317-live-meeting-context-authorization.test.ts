import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.js';

const binding = { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call-1' };
const query = { invocationId: 'invocation-1', catId: binding.catId, threadId: binding.threadId };

function gateFor(householdReads: boolean, onWrite: () => void): LiveContextGate {
  return new LiveContextGate({
    binding,
    acceptsInput: () => true,
    matchesInvocation: (candidate) => candidate.invocationId === query.invocationId,
    householdToolsEnabled: () => householdReads,
    verifyCompanion: async () => true,
    run: (operation) => operation(),
    client: () => ({
      request: async () => ({}),
      submitText: async () => 'unused',
      submitContextAtBoundary: async (_text, _refs, _kind, _signal, authorize) => {
        if (!(await authorize())) throw new Error('source revoked before native write');
        onWrite();
        return 'native-turn';
      },
    }),
  });
}

test('an explicit per-call meeting grant works without the separate household-read choice', async () => {
  let writes = 0;
  const gate = gateFor(false, () => writes++);
  const scope = gate.scope(query);
  assert.ok(scope);
  assert.equal(
    await gate.inject({
      scope,
      kind: 'meeting_context',
      text: 'Untrusted meeting excerpt',
      sourceRefs: ['f195-transcript:home:mtg-1:artifact:1:1'],
      signal: new AbortController().signal,
      authorizeSource: async () => true,
    }),
    'accepted',
  );
  assert.equal(writes, 1);
  gate.close('test');
});

test('household-read permission never substitutes for a meeting share grant', async () => {
  let writes = 0;
  const gate = gateFor(true, () => writes++);
  const scope = gate.scope(query);
  assert.ok(scope);
  await assert.rejects(
    gate.inject({
      scope,
      kind: 'meeting_context',
      text: 'Untrusted meeting excerpt',
      sourceRefs: ['f195-transcript:home:mtg-1:artifact:1:1'],
      signal: new AbortController().signal,
    }),
    /unavailable|grant/i,
  );
  assert.equal(writes, 0);
  gate.close('test');
});
