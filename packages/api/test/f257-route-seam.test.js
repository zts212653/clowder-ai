/** F257 S5: serial and parallel routes share one session HookPipeline result. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
  }
  async set(k, v, ...args) {
    if (args.includes('NX') && this.kv.has(k)) return null;
    this.kv.set(k, v);
    return 'OK';
  }
  async get(k) {
    return this.kv.get(k) ?? null;
  }
  async del(k) {
    this.kv.delete(k);
    return 1;
  }
  async zadd(k, score, m) {
    const s = this.sorted.get(k) ?? new Map();
    s.set(m, score);
    this.sorted.set(k, s);
    return 1;
  }
  async zrangebyscore(k, min, max) {
    const s = this.sorted.get(k);
    if (!s) return [];
    return [...s.entries()]
      .filter(([, sc]) => sc >= min && sc <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrevrange(k, a, b) {
    const s = this.sorted.get(k);
    if (!s) return [];
    return [...s.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(a, b + 1)
      .map(([m]) => m);
  }
  async zrem(k, m) {
    return this.sorted.get(k)?.delete(m) ? 1 : 0;
  }
  async sadd(k, ...ms) {
    const s = this.sets.get(k) ?? new Set();
    for (const m of ms) s.add(m);
    this.sets.set(k, s);
    return ms.length;
  }
  async smembers(k) {
    return [...(this.sets.get(k) ?? [])];
  }
  async scan(_c, ...args) {
    const i = args.indexOf('MATCH');
    const pat = i >= 0 ? args[i + 1] : '*';
    const rx = new RegExp(`^${pat.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['0', [...new Set([...this.kv.keys(), ...this.sorted.keys()])].filter((x) => rx.test(x))];
  }
}

function mockService(catId, { native, captures }) {
  return {
    async *invoke(_messages, options) {
      captures.push(Object.assign({ __messages: _messages }, options));
      yield { type: 'text', catId, content: 'reply', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
    ...(native ? { injectsL0Natively: () => true } : {}),
  };
}

let invocationSequence = 0;

function createMockDeps(services) {
  let msg = 0;
  const byId = new Map();
  return {
    services,
    injectionTraceStore: true, // truthy → route runs the trailing drainCapturedTraces()
    invocationDeps: {
      registry: {
        create: () => {
          const invocationId = ++invocationSequence;
          return { invocationId: `inv-${invocationId}`, callbackToken: `tok-${invocationId}` };
        },
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => '/tmp/t' },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
        isRebornSession: async () => false,
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (m) => {
        const s = { id: `m-${++msg}`, ...m, threadId: m.threadId ?? 'default' };
        byId.set(s.id, s);
        return s;
      },
      getById: async (id) => byId.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

async function pollTrace(store, threadId, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summaries = await store.queryWindow(threadId, 0, Date.now() + 1000);
    const hit = summaries.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe('F257 #2 route seam (2b R2 P2-2)', () => {
  let routeParallel;
  let routeSerial;
  let StoreMod;
  let catReg;
  let store;
  let buildStaticIdentity;
  /** Isolated profile root. The routes build their own FileProfileRepository, which
   *  falls back to $HOME/.cat-cafe when CAT_CAFE_DATA_DIR is unset — so an injected
   *  repository would not protect them. Isolate the env the repository actually reads,
   *  and restore whatever was there before. */
  let profileDataDir;
  let priorProfileDataDir;

  before(async () => {
    priorProfileDataDir = process.env.CAT_CAFE_DATA_DIR;
    profileDataDir = mkdtempSync(join(tmpdir(), 'f257-seam-profile-'));
    process.env.CAT_CAFE_DATA_DIR = profileDataDir;
    const shared = await import('@cat-cafe/shared');
    catReg = shared.catRegistry;
    catReg.reset();
    for (const id of ['nativecat', 'plaincat']) {
      catReg.register(id, {
        displayName: '布偶猫',
        nickname: id,
        name: 'Ragdoll',
        roleDescription: 'x',
        personality: 'y',
        defaultModel: 'claude-opus-4-6',
        mentionPatterns: [`@${id}`],
        restrictions: [],
        clientId: 'anthropic',
        breedId: 'ragdoll',
        relationshipKey: 'ragdoll',
      });
    }
    routeParallel = (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
    routeSerial = (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial;
    buildStaticIdentity = (await import('../dist/domains/cats/services/context/SystemPromptBuilder.js'))
      .buildStaticIdentity;
    StoreMod = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const traceBootstrap = await import('../dist/domains/prompt-hooks/trace-bootstrap.js');

    const redis = new FakeRedis();
    traceBootstrap.bootstrapTraceStore(redis);
    store = new StoreMod.InjectionTraceStore(redis);
  });

  after(() => {
    catReg?.reset();
    if (priorProfileDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorProfileDataDir;
    if (profileDataDir) rmSync(profileDataDir, { recursive: true, force: true });
  });

  async function drain(route, catId, threadId, captures) {
    for await (const _m of route(
      createMockDeps({ [catId]: mockService(catId, { native: catId === 'nativecat', captures }) }),
      [catId],
      'hi',
      'user1',
      threadId,
      {},
    )) {
      // drain the route generator
    }
  }

  for (const [mode, getRoute] of [
    ['parallel', () => routeParallel],
    ['serial', () => routeSerial],
  ]) {
    // S14: the owner profile must reach BOTH carriers. Asserted here rather than by
    // calling buildStaticIdentity twice, because only this seam proves the route
    // actually resolved and passed profile truth.
    test(`${mode}: both carriers receive the owner profile the route resolved`, async () => {
      // Fixture paths come from the repository contract, not from hand-built paths, so a
      // layout change cannot make this test silently stop covering delivery.
      const { FileProfileRepository } = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
      const { installOwnerUserId } = await import('../dist/config/install-owner.js');
      // Explicit dataDir, matching the CAT_CAFE_DATA_DIR the suite pinned: this test
      // writes owner profile files, and must never reach a real ~/.cat-cafe.
      const repo = new FileProfileRepository({ dataDir: profileDataDir });
      assert.equal(repo.dataDir, profileDataDir, 'profile writes must stay inside the isolated root');
      const ownerId = installOwnerUserId();
      const nativeDir = repo.profileDir(ownerId);
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativeDir, 'operator-capsule.md'), 'lang：co-creator，证据优先。\n');
      const primer = repo.primerPath(repo.scope(ownerId, 'nativecat'));
      mkdirSync(dirname(primer), { recursive: true });
      writeFileSync(primer, '关系轨迹正文（不应进入 prompt）\n');
      const plainPrimer = repo.primerPath(repo.scope(ownerId, 'plaincat'));
      mkdirSync(dirname(plainPrimer), { recursive: true });
      writeFileSync(plainPrimer, '关系轨迹正文（不应进入 prompt）\n');

      const captures = [];
      await drain(getRoute(), 'nativecat', `seam-${mode}-profile-native`, captures);
      const nativeDelivered = captures[0]?.nativeSessionPrompt ?? '';
      assert.match(nativeDelivered, /## 主人画像/, 'native carrier must receive the owner capsule');
      assert.match(
        nativeDelivered,
        /cat-cafe-profile:\/\/relationship\/current/,
        'native carrier must receive the relationship pointer',
      );

      const plainCaptures = [];
      await drain(getRoute(), 'plaincat', `seam-${mode}-profile-plain`, plainCaptures);
      const prepended = JSON.stringify(plainCaptures[0]?.__messages ?? []);
      assert.match(prepended, /## 主人画像/, 'non-native carrier must receive the owner capsule');
      assert.match(
        prepended,
        /cat-cafe-profile:\/\/relationship\/current/,
        'non-native carrier must receive the relationship pointer',
      );
      // INV-6: a pointer says the trajectory exists and how to read it, never its content.
      assert.equal(nativeDelivered.includes('不应进入 prompt'), false, 'pointer must not leak primer content');
      assert.equal(prepended.includes('不应进入 prompt'), false, 'pointer must not leak primer content');
    });

    // 砚砚 P2: the on-disk r1/r2 regression in prompt-profile-delivery proves the
    // repository and builder read new bytes, but it never re-enters a route. The cache
    // that was removed with the L0 compiler sat in front of the route, so only a second
    // real invocation can prove the route re-resolves instead of reusing its snapshot.
    test(`${mode}: a later invocation delivers the edited capsule to both carriers`, async () => {
      const { FileProfileRepository } = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
      const { installOwnerUserId } = await import('../dist/config/install-owner.js');
      const repo = new FileProfileRepository({ dataDir: profileDataDir });
      assert.equal(repo.dataDir, profileDataDir, 'profile writes must stay inside the isolated root');
      const ownerId = installOwnerUserId();
      const capsulePath = join(repo.profileDir(ownerId), 'operator-capsule.md');
      mkdirSync(dirname(capsulePath), { recursive: true });

      const deliver = async (catId, threadId) => {
        const captures = [];
        await drain(getRoute(), catId, threadId, captures);
        return catId === 'nativecat'
          ? (captures[0]?.nativeSessionPrompt ?? '')
          : JSON.stringify(captures[0]?.__messages ?? []);
      };

      for (const catId of ['nativecat', 'plaincat']) {
        writeFileSync(capsulePath, `r1 ${catId} 画像内容\n`);
        const r1 = await deliver(catId, `seam-${mode}-r1-${catId}`);
        assert.match(r1, new RegExp(`r1 ${catId} 画像内容`), `${catId}: first invocation delivers revision 1`);

        writeFileSync(capsulePath, `r2 ${catId} 画像内容\n`);
        const r2 = await deliver(catId, `seam-${mode}-r2-${catId}`);
        assert.match(r2, new RegExp(`r2 ${catId} 画像内容`), `${catId}: later invocation delivers the edited file`);
        assert.equal(
          r2.includes(`r1 ${catId} 画像内容`),
          false,
          `${catId}: the route must not reuse the previous revision's snapshot`,
        );
      }
    });

    test(`${mode}: native carrier receives the exact route-owned session prompt and traces L1-L7`, async () => {
      const threadId = `seam-${mode}-native`;
      // The carrier must receive exactly the builder's bytes for the same inputs, and
      // S14's profile is now one of those inputs. Resolve it the way the route does, so
      // this holds whether or not another test has already written profile fixtures.
      const { resolveOwnerProfileSnapshot } = await import(
        '../dist/domains/cats/services/profile/owner-profile-snapshot.js'
      );
      const expectedPrompt = buildStaticIdentity('nativecat', {
        mcpAvailable: false,
        profile: resolveOwnerProfileSnapshot({ catId: 'nativecat' }),
      });
      const captures = [];
      await drain(getRoute(), 'nativecat', threadId, captures);
      assert.equal(captures.length, 1);
      assert.equal(captures[0].nativeSessionPrompt, expectedPrompt, 'carrier gets exact HookPipeline bytes');
      const summary = await pollTrace(store, threadId, (s) => s.segments.some((x) => x.segmentId === 'L4'));
      assert.ok(summary, `${mode}: native-L0 trace was persisted`);
      const invocationIds = await store.listUnclassifiedInvocationIds('user1', 0, Date.now() + 1000, 100);
      const episodes = await Promise.all(
        invocationIds.map((invocationId) => store.getEpisodeByInvocationId(invocationId)),
      );
      const episode = episodes.find((candidate) => candidate?.terminal.threadId === threadId);
      assert.ok(episode, `${mode}: terminal episode was closed after output persistence`);
      assert.equal(episode.terminal.traceTurnId, summary.turnId, 'terminal sidecar joins the exact persisted trace');
      assert.equal(episode.terminal.terminalKind, 'completed');
      assert.match(episode.terminal.outputMessageId, /^m-/);
      const lSegs = summary.segments.filter((s) => /^L\d/.test(s.segmentId));
      assert.equal(lSegs.length, 7, 'all L1-L7 present');
      assert.ok(lSegs.every((s) => s.status === 'observed' && s.pipelineStatus === 'fired'));
      const session = summary.delivery.find((d) => d.stage === 'session-init');
      assert.equal(session.channel, 'native-l0', 'session was transported by the native carrier');
    });

    test(`${mode}: non-native cat stays on the existing pipeline path (message-prepend, S/D segments)`, async () => {
      const threadId = `seam-${mode}-plain`;
      const captures = [];
      await drain(getRoute(), 'plaincat', threadId, captures);
      assert.equal(captures.length, 1);
      assert.equal(captures[0].nativeSessionPrompt, undefined);
      // Non-vacuous: REQUIRE the existing path to have actually persisted a trace. If the
      // non-native persistence were deleted/broken, summaries=[] would make the "no native-l0
      // / no L" checks pass falsely — so first prove a trace exists, then assert its shape.
      const summary = await pollTrace(store, threadId, (s) => s.segments.length > 0);
      assert.ok(summary, `${mode}: non-native path persisted a trace (existing pipeline ran)`);
      const invocationIds = await store.listUnclassifiedInvocationIds('user1', 0, Date.now() + 1000, 100);
      const episodes = await Promise.all(
        invocationIds.map((invocationId) => store.getEpisodeByInvocationId(invocationId)),
      );
      const episode = episodes.find((candidate) => candidate?.terminal.threadId === threadId);
      assert.ok(episode, `${mode}: non-native terminal episode was closed after output persistence`);
      assert.equal(episode.terminal.traceTurnId, summary.turnId, 'terminal sidecar joins the exact persisted trace');
      assert.match(episode.terminal.outputMessageId, /^m-/);
      const session = summary.delivery.find((d) => d.stage === 'session-init');
      assert.equal(session.channel, 'message-prepend', 'non-native session uses message-prepend, not native-l0');
      // Both transports observe the same L1-L7 hook IDs.
      const lSegs = summary.segments.filter((s) => /^L\d/.test(s.segmentId));
      if (lSegs.length > 0) {
        // L-segments exist from the standard hook pipeline — verify they carry pipeline
        // status (execution truth) rather than being opaque compiler-injected blobs.
        assert.ok(
          lSegs.every((s) => s.pipelineStatus !== undefined),
          'non-native L-segments carry pipeline execution status',
        );
      }
      const pipelineSeg = summary.segments.find((x) => /^[SD]\d/.test(x.segmentId));
      assert.ok(pipelineSeg, 'existing pipeline S/D segments present (path unchanged)');
      assert.ok(
        ['observed', 'absent'].includes(pipelineSeg.status),
        'existing pipeline segment carries a real observed/absent status',
      );
    });
  }
});
