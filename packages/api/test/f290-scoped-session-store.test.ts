import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionSealer } from '../src/domains/cats/services/session/SessionSealer.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';
import {
  scopedSessionBase as base,
  scopedSessionInvocation as scoped,
  verifyScopedSessionStore,
  verifyScopedWithoutHome,
} from './helpers/f290-scoped-session-contract.js';

test('scoped-only chains cannot be adopted by home fallback, even after a later home session closes', async () => {
  await verifyScopedWithoutHome(new SessionChainStore());
});

test('one-shot scoped records preserve home active identity through create, bind, seal and restore refusal', async () => {
  await verifyScopedSessionStore(new SessionChainStore());
});

test('scoped sealing archives the real transcript without home memory, generative digest or post-seal side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-scoped-seal-'));
  try {
    const store = new SessionChainStore();
    const writer = new TranscriptWriter({ dataDir: directory });
    const input = { ...base, scopedInvocation: scoped('child-archive') };
    const record = await store.create(input);
    await writer.appendDurableEvent(
      { sessionId: record.id, ...base, seq: record.seq },
      { type: 'text', catId: base.catId, content: 'Real public-only output' },
      'child-archive',
    );
    let privateReads = 0;
    let hooks = 0;
    const sealer = new SessionSealer(store, writer, undefined, undefined, {
      getBootstrapDepth() {
        privateReads++;
        return 'generative';
      },
      async resolveProfile() {
        privateReads++;
        return null;
      },
    });
    sealer.registerPostSealHook(async () => {
      hooks++;
    });
    await sealer.requestSeal({ sessionId: record.id, reason: 'scoped_complete' });
    assert.deepEqual(await sealer.finalize({ sessionId: record.id }), { sealed: true, clean: true });
    assert.equal(privateReads, 0, 'an external scoped call cannot start a home digest operation');
    assert.equal(hooks, 0, 'scoped completion cannot trigger ordinary home post-seal hooks');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
