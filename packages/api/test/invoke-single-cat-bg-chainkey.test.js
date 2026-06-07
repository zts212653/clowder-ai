/**
 * F198 Bug #3: bg carrier chainKey consumer (invoke-single-cat)
 *
 * Root cause: the bg daemon forks a fresh sessionId UUID every `--bg --resume`
 * round, so cliSessionId is NOT a stable conversation identity. The old
 * session_init path saw "cliSessionId changed" → seal+create, inflating one
 * conversation into N sealed records and losing the resume id chain.
 *
 * Fix: when service.usesChainKeyResume() === true, invoke derives a stable
 * chainKey = `bg:${threadId}:${catId}` and routes:
 *   - sessionId resolution  → getByChainKey().latestResumeSessionId
 *   - session_init record    → getByChainKey() reuse (update cliSessionId, NO seal)
 *   - done bookkeeping       → getByChainKey() update messageCount + latestResumeSessionId
 * Non-bg providers keep the cliSessionId / getActive path unchanged.
 *
 * NOTE on the resume mutex (design #2): bg uses chainKey as the mutex key
 * (stable across daemon rotation) instead of sessionId. The mutex is a
 * module-level singleton (not injectable without an out-of-scope F118 refactor),
 * and its串行化 only materializes across daemon processes — so it is covered by
 * code review + the "single record / messageCount intact" behavior below rather
 * than a standalone unit test.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let tempDir;
let invokeSingleCat;
let SessionChainStore;

describe('F198 Bug #3: bg carrier chainKey consumer', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-bg-chainkey-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    invokeSingleCat = (await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'))
      .invokeSingleCat;
    SessionChainStore = (await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'))
      .SessionChainStore;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDeps(overrides = {}) {
    let counter = 0;
    return {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...overrides,
    };
  }

  // bg carrier service: usesChainKeyResume() === true. Captures the resume
  // sessionId it was handed, emits session_init (daemon shortId rotates) + done
  // (carries the next-round resumeSessionId in metadata).
  function makeBgService(daemonShortId, resumeSessionId, { emitDone = true, emitText = true } = {}) {
    const captured = {};
    const service = {
      usesChainKeyResume: () => true,
      async *invoke(_prompt, options) {
        captured.sessionId = options?.sessionId;
        yield {
          type: 'session_init',
          catId: 'opus',
          sessionId: daemonShortId,
          timestamp: Date.now(),
          metadata: { provider: 'claude-bg', model: 'claude-opus-4-7' },
        };
        if (emitText) {
          yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        }
        if (emitDone) {
          yield {
            type: 'done',
            catId: 'opus',
            timestamp: Date.now(),
            metadata: { provider: 'claude-bg', resumeSessionId },
          };
        }
      },
    };
    return { service, captured };
  }

  it('reuses ONE record across daemon sessionId rotation (no seal+create inflation)', async () => {
    const store = new SessionChainStore();
    const threadId = 'thread-bg-reuse';
    const rounds = [
      ['daemon-1', 'uuid-0001'],
      ['daemon-2', 'uuid-0002'],
      ['daemon-3', 'uuid-0003'],
    ];
    for (const [short, resume] of rounds) {
      const { service } = makeBgService(short, resume);
      await collect(
        invokeSingleCat(
          { ...makeDeps(), sessionChainStore: store },
          { catId: 'opus', service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
        ),
      );
    }
    const chain = store.getChain('opus', threadId);
    assert.equal(chain.length, 1, 'should be exactly ONE record (chainKey reuse, not 3 sealed)');
    assert.equal(chain[0].chainKey, `bg:${threadId}:opus`, 'record indexed by stable chainKey');
    assert.equal(chain[0].cliSessionId, 'daemon-3', 'cliSessionId follows latest daemon shortId');
    assert.equal(chain[0].messageCount, 3, 'messageCount accumulates across rounds');
    assert.equal(chain[0].latestResumeSessionId, 'uuid-0003', 'latest fork id chained for next resume');
  });

  it('passes prior latestResumeSessionId as the next-round --resume target', async () => {
    const store = new SessionChainStore();
    const threadId = 'thread-bg-resume-target';

    const r1 = makeBgService('daemon-1', 'uuid-0001');
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r1.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );
    assert.equal(r1.captured.sessionId, undefined, 'first round: no prior resume id');

    const r2 = makeBgService('daemon-2', 'uuid-0002');
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r2.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );
    assert.equal(r2.captured.sessionId, 'uuid-0001', 'second round: resume from prior latestResumeSessionId');
  });

  it('keeps non-bg providers on the cliSessionId path (no chainKey record)', async () => {
    const store = new SessionChainStore();
    const threadId = 'thread-non-bg';
    const service = {
      // no usesChainKeyResume — regular `-p` provider
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-xyz', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );
    const chain = store.getChain('opus', threadId);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].chainKey, undefined, 'non-bg record must NOT carry a chainKey');
    assert.equal(chain[0].cliSessionId, 'cli-xyz', 'non-bg keeps cliSessionId identity');
    assert.equal(store.getByChainKey(`bg:${threadId}:opus`), null, 'no chainKey index created for non-bg');
  });

  it('cancel mid-stream (no done) keeps prior latestResumeSessionId for the next round', async () => {
    const store = new SessionChainStore();
    const threadId = 'thread-bg-cancel';

    // Round 1: completes normally → latestResumeSessionId = uuid-0001
    const r1 = makeBgService('daemon-1', 'uuid-0001');
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r1.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );

    // Round 2: cancelled mid-stream — session_init arrives but NO done event.
    const r2 = makeBgService('daemon-2', 'uuid-0002', { emitDone: false });
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r2.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );

    const rec = store.getByChainKey(`bg:${threadId}:opus`);
    assert.ok(rec, 'record still reachable by chainKey after cancel');
    assert.equal(rec.latestResumeSessionId, 'uuid-0001', 'cancelled round must NOT overwrite the kept resume id');

    // Round 3: resumes from the KEPT id (invalidate-and-keep)
    const r3 = makeBgService('daemon-3', 'uuid-0003');
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r3.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );
    assert.equal(r3.captured.sessionId, 'uuid-0001', 'round 3 resumes from the kept id, not the cancelled round');
  });

  it('does NOT resume a sealed bg record — starts fresh (cloud review P1)', async () => {
    // An external sealer (threshold overflow / manual / reaper) may seal a bg
    // record. getByChainKey returns it regardless of status (write tolerance),
    // so resume/reuse paths MUST check status — a sealed conversation must not
    // be resumed+mutated, it must start fresh (mirrors the non-bg boundary).
    const store = new SessionChainStore();
    const threadId = 'thread-bg-sealed';

    const r1 = makeBgService('daemon-1', 'uuid-0001');
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r1.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );
    const rec1 = store.getByChainKey(`bg:${threadId}:opus`);
    assert.equal(rec1.latestResumeSessionId, 'uuid-0001');

    // External seal (simulate threshold / manual / reaper sealing the record).
    store.update(rec1.id, { status: 'sealed' });

    const r2 = makeBgService('daemon-2', 'uuid-0002');
    await collect(
      invokeSingleCat(
        { ...makeDeps(), sessionChainStore: store },
        { catId: 'opus', service: r2.service, prompt: 'p', userId: 'u', threadId, isLastCat: true },
      ),
    );
    assert.equal(r2.captured.sessionId, undefined, 'must NOT resume a sealed bg record');

    const recAfter = store.getByChainKey(`bg:${threadId}:opus`);
    assert.equal(recAfter.status, 'active', 'fresh start creates a new ACTIVE record');
    assert.notEqual(recAfter.id, rec1.id, 'must be a NEW record, not the revived sealed one');
    assert.equal(store.get(rec1.id).status, 'sealed', 'the sealed record stays sealed (not revived)');
  });
});
