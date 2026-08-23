import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

// Use a real home cat id because prompt-capture/L0 validation crosses a
// subprocess boundary and intentionally reloads the canonical registry.
const TEST_CAT_ID = 'codex';
const MANUAL_WINDOW = 258_400;
const CODEX_EFFECTIVE_PERCENT = 0.95;
const EFFECTIVE_WINDOW = Math.floor(MANUAL_WINDOW * CODEX_EFFECTIVE_PERCENT); // 245480

// Codex exec_json reports token_count.model_context_window AFTER applying its
// effective_context_window_percent to the injected native model_context_window.
const codexEffectiveReport = (nativeWindow) => Math.floor(nativeWindow * CODEX_EFFECTIVE_PERCENT);

describe('issue #1381: Codex exec_json native/effective context window feedback loop', () => {
  let resolveInvocationCapacitySnapshot;
  let applyUsageEvidenceToInvocationSnapshot;
  let applyActiveSessionCapacityPin;
  let SessionChainStore;
  let ContextEpochOwner;
  let InMemoryContextEpochStore;
  let savedConfigs;

  function registerTestCat(contextWindow = MANUAL_WINDOW, defaultModel = 'gpt-5.6-sol', accountRef = 'codex-oauth') {
    catRegistry.reset();
    catRegistry.register(TEST_CAT_ID, {
      id: TEST_CAT_ID,
      name: TEST_CAT_ID,
      displayName: 'Issue 1381 Test',
      avatar: '🐱',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@issue-1381-codex-window'],
      clientId: 'openai',
      ...(accountRef ? { accountRef } : {}),
      provider: 'openai',
      defaultModel,
      // null = Auto mode (no manual member window; catalog/report-owned).
      ...(contextWindow === null ? {} : { contextWindow }),
      mcpSupport: false,
      roleDescription: 'test',
      personality: 'test',
    });
  }

  function execJsonService() {
    return {
      async *invoke() {},
      contextCapability() {
        return {
          provider: 'openai',
          carrier: 'exec_json',
          reportsRuntimeWindow: true,
          authoritativeUsage: true,
          usageTelemetry: 'available',
          nativeWindowControl: true,
          nativeCompressionControl: true,
          observesCompression: true,
          reason: 'test codex exec_json carrier',
        };
      },
    };
  }

  before(async () => {
    ({ resolveInvocationCapacitySnapshot, applyUsageEvidenceToInvocationSnapshot, applyActiveSessionCapacityPin } =
      await import('../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'));
    ({ SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
    ({ ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js'));
    ({ InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js'));
    savedConfigs = catRegistry.getAllConfigs();
  });

  after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedConfigs)) catRegistry.register(id, config);
  });

  /**
   * One resume round: resolve member config, apply the session pin, inject the
   * native window into Codex, observe Codex's effective report, apply the pin
   * again. Returns the post-report snapshot.
   */
  async function runResumeRound(store, threadId, reportOverride) {
    const resolved = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: execJsonService(),
    });
    const pinned = await applyActiveSessionCapacityPin({
      snapshot: resolved,
      catId: TEST_CAT_ID,
      threadId,
      sessionChainStore: store,
    });
    // Codex applies its 95% effective factor to whatever native window we
    // injected; the report must never become the next native window.
    const report = reportOverride ?? codexEffectiveReport(pinned.nativeWindowTokens);
    const observed = applyUsageEvidenceToInvocationSnapshot({
      snapshot: pinned,
      catId: TEST_CAT_ID,
      capability: pinned.capability,
      reportedWindowSize: report,
    });
    return applyActiveSessionCapacityPin({
      snapshot: observed,
      catId: TEST_CAT_ID,
      threadId,
      sessionChainStore: store,
    });
  }

  it('keeps the manual-configured native window stable across 12 resumes of the same session', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-stability';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-stability',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    // Round 1 establishes the pin: native 258400 → Codex reports 245480.
    const first = await runResumeRound(store, threadId);
    assert.equal(first.nativeWindowTokens, MANUAL_WINDOW);
    assert.equal(first.capacity.windowTokens, EFFECTIVE_WINDOW);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);

    // Rounds 2..12 must be a fixed point: before the fix each round fed the
    // effective report back as the next native window (258400 → 245480 →
    // 233206 → …); now the native window comes from member config every time.
    for (let round = 2; round <= 12; round += 1) {
      const snapshot = await runResumeRound(store, threadId);
      assert.equal(
        snapshot.nativeWindowTokens,
        MANUAL_WINDOW,
        `round ${round}: native model_context_window must stay at the configured ${MANUAL_WINDOW}`,
      );
      assert.equal(
        snapshot.capacity.windowTokens,
        EFFECTIVE_WINDOW,
        `round ${round}: effective capacity must stay at ${EFFECTIVE_WINDOW}, not shrink recursively`,
      );
      assert.equal(
        store.get(active.id)?.capacityPin?.windowTokens,
        EFFECTIVE_WINDOW,
        `round ${round}: session pin must stay at ${EFFECTIVE_WINDOW}`,
      );
    }
  });

  it('still shrinks the pin when the provider independently reports a genuinely smaller window', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-genuine-shrink';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-shrink',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    await runResumeRound(store, threadId);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);

    // A genuinely independent reduction (e.g. provider/model metadata change),
    // not the 95% echo of our own injection.
    const shrunk = await runResumeRound(store, threadId, 200_000);
    assert.equal(shrunk.capacity.windowTokens, 200_000);
    assert.equal(shrunk.capacity.source, 'reported');
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);

    // The shrink persists and does not oscillate back while the provider keeps
    // reporting the reduced window.
    const steady = await runResumeRound(store, threadId, 200_000);
    assert.equal(steady.capacity.windowTokens, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
  });

  it('never auto-expands a pin on a larger fresh report — recovery stays explicit via seal/rollover', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-recovery';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-recovery',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    // Pin polluted by the old feedback loop (258400 * 0.95^11 ≈ 146973).
    store.update(active.id, {
      capacityPin: {
        windowTokens: 146_973,
        inputCeilingTokens: 130_973,
        source: 'reported',
        provenance: 'Carrier reported 146,973 tokens (polluted by pre-fix feedback loop)',
        actionable: true,
      },
    });

    // Codex now reports the stable effective window (245480) — larger than the
    // polluted pin. A larger report cannot distinguish pre-fix pollution from
    // a genuine shrink followed by genuine recovery, so the pin must NOT
    // auto-expand; the recoverable state is surfaced in the provenance.
    const clamped = await runResumeRound(store, threadId);
    assert.equal(clamped.capacity.windowTokens, 146_973);
    assert.match(clamped.capacity.provenance, /session-pinned/);
    assert.match(clamped.capacity.provenance, /seal the session to recover/);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 146_973);

    // Maintainer P1: the hint must also land on the STORED pin (the Hub and
    // digests read the session record, not the per-invocation snapshot),
    // deduplicated and without touching the numeric pin.
    const storedPin = store.get(active.id)?.capacityPin;
    assert.match(storedPin?.provenance, /carrier now reports 245,480 tokens — seal the session to recover/);
    const secondRound = await runResumeRound(store, threadId);
    const persistedPin = store.get(active.id)?.capacityPin;
    assert.equal(persistedPin?.windowTokens, 146_973);
    assert.equal(
      persistedPin?.provenance?.match(/seal the session to recover/g)?.length,
      1,
      'recovery hint must be persisted once, not re-appended every round',
    );
    assert.equal(
      secondRound.capacity.provenance.match(/seal the session to recover/g)?.length,
      1,
      'the returned snapshot must carry the hint exactly once on repeat rounds',
    );

    // Explicit recovery: sealing the session ends the pin; the fresh session
    // adopts the carrier-reported capacity on its first invocation.
    store.update(active.id, { status: 'sealed' });
    const fresh = store.create({
      cliSessionId: 'cli-issue-1381-recovered',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    const recovered = await runResumeRound(store, threadId);
    assert.equal(recovered.capacity.windowTokens, EFFECTIVE_WINDOW);
    assert.equal(store.get(fresh.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);
  });

  it('does not expand a genuinely shrunk pin when the provider later reports a larger window', async () => {
    // 砚砚 review counterexample: genuine provider shrink to 200K, then a later
    // report of 245480. The larger report is genuine independent evidence, but
    // expansion past the pin remains gated on rollover.
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-genuine-then-larger';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-genuine-then-larger',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    await runResumeRound(store, threadId, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);

    const later = await runResumeRound(store, threadId, EFFECTIVE_WINDOW);
    assert.equal(later.capacity.windowTokens, 200_000);
    assert.match(later.capacity.provenance, /session-pinned/);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
    // The larger raw report exceeds the active pin → the recovery hint is
    // persisted on the stored record (the pin itself stays clamped).
    assert.match(store.get(active.id)?.capacityPin?.provenance, /seal the session to recover/);
  });

  it('gates the recovery hint on the raw report vs the active pin (manual cap + floor-raised candidate)', async () => {
    // Maintainer P1 exact counterexample: manual 258400 + claude-fable-5 +
    // active pin 200000 + raw report 245480. The KNOWN_MIN floor lifts the
    // resolver candidate past the raw report (manual branch → 258400), so the
    // old predicate (report >= resolvedPin) silently produced no hint. The pin
    // correctly stays 200000; the hint must fire because the RAW report
    // exceeds the ACTIVE pin.
    registerTestCat(undefined, 'claude-fable-5');
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-floor-manual';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-floor-manual',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      capacityPin: {
        windowTokens: 200_000,
        inputCeilingTokens: 184_000,
        source: 'reported',
        provenance: 'Carrier reported 200,000 tokens',
        actionable: true,
      },
    });

    const clamped = await runResumeRound(store, threadId, EFFECTIVE_WINDOW);
    assert.equal(clamped.capacity.windowTokens, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
    assert.match(store.get(active.id)?.capacityPin?.provenance, /seal the session to recover/);
  });

  it('does not expand a pin from a floor-raised catalog value without raw provider proof', async () => {
    // claude-fable-5 in Auto mode (no manual member window): KNOWN_MIN floor
    // raises any raw report below 1M to 1M in the resolver — the resolved
    // candidate therefore exceeds the active 200K pin in BOTH controls, so
    // only the raw report can distinguish them. Positive: raw 245480 > pin →
    // hint persisted. Negative: raw 200000 == pin → no hint. In neither case
    // may the pin expand on the floor-raised value.
    registerTestCat(null, 'claude-fable-5');
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-floor';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-floor',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      capacityPin: {
        windowTokens: 200_000,
        inputCeilingTokens: 184_000,
        source: 'reported',
        provenance: 'Carrier reported 200,000 tokens',
        actionable: true,
      },
    });

    const positive = await runResumeRound(store, threadId, EFFECTIVE_WINDOW);
    assert.equal(positive.capacity.windowTokens, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
    assert.match(store.get(active.id)?.capacityPin?.provenance, /seal the session to recover/);

    // Negative control on a fresh session: raw report equal to the pin proves
    // nothing recoverable even after floor-raising — no hint may appear.
    registerTestCat(null, 'claude-fable-5');
    const controlStore = new SessionChainStore();
    const controlThreadId = 'thread-issue-1381-floor-control';
    const control = controlStore.create({
      cliSessionId: 'cli-issue-1381-floor-control',
      threadId: controlThreadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    controlStore.update(control.id, {
      capacityPin: {
        windowTokens: 200_000,
        inputCeilingTokens: 184_000,
        source: 'reported',
        provenance: 'Carrier reported 200,000 tokens',
        actionable: true,
      },
    });

    const negative = await runResumeRound(controlStore, controlThreadId, 200_000);
    assert.equal(negative.capacity.windowTokens, 200_000);
    assert.equal(controlStore.get(control.id)?.capacityPin?.windowTokens, 200_000);
    assert.doesNotMatch(controlStore.get(control.id)?.capacityPin?.provenance, /seal the session to recover/);
  });

  it('merges the persisted recovery hint onto the current pin — a concurrent shrink is never undone', async () => {
    // Maintainer P1 interleaving probe: invocation A reads active pin 200000
    // and pauses at the recovery-note write for raw report 245480; invocation
    // B lands a genuine shrink to 150000; A's delayed write must NOT restore
    // the stale 200000. The final pin stays 150000 with the hint present
    // exactly once.
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-lost-update';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-lost-update',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      capacityPin: {
        windowTokens: 200_000,
        inputCeilingTokens: 184_000,
        source: 'reported',
        provenance: 'Carrier reported 200,000 tokens',
        actionable: true,
      },
    });

    const atomicAppend = store.appendCapacityPinProvenance.bind(store);
    store.appendCapacityPinProvenance = (id, note) => {
      // Invocation B's genuine shrink lands while A is paused at the note write.
      store.update(id, {
        capacityPin: {
          windowTokens: 150_000,
          inputCeilingTokens: 134_000,
          source: 'reported',
          provenance: 'Carrier reported 150,000 tokens',
          actionable: true,
        },
        updatedAt: Date.now(),
      });
      return atomicAppend(id, note);
    };

    const returned = await runResumeRound(store, threadId, EFFECTIVE_WINDOW);
    const finalPin = store.get(active.id)?.capacityPin;
    assert.equal(finalPin?.windowTokens, 150_000, 'delayed note write must not undo the concurrent shrink');
    assert.match(finalPin?.provenance, /carrier now reports 245,480 tokens — seal the session to recover/);
    assert.equal(
      finalPin?.provenance?.match(/seal the session to recover/g)?.length,
      1,
      'recovery hint must be present exactly once',
    );
    // 太阳猫 review P1: the returned snapshot must be built from the current
    // (post-race) pin too — not the caller's stale 200000 read.
    assert.equal(returned.capacity.windowTokens, 150_000, 'returned view must reflect the concurrent shrink');
    assert.equal(
      returned.capacity.provenance.match(/seal the session to recover/g)?.length,
      1,
      'returned provenance carries the hint exactly once',
    );
  });

  it('keeps exactly one recovery instruction per pin when the larger report number jitters', async () => {
    // 太阳猫 review P2: exact-string dedup treats 245480 → 245481 as different
    // notes and appends twice. The recovery instruction must be a stable
    // singleton — the latest report number replaces the previous note in
    // place, on both the stored pin and the returned snapshot.
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-hint-jitter';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-hint-jitter',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      capacityPin: {
        windowTokens: 146_973,
        inputCeilingTokens: 130_973,
        source: 'reported',
        provenance: 'Carrier reported 146,973 tokens (polluted by pre-fix feedback loop)',
        actionable: true,
      },
    });

    await runResumeRound(store, threadId, 245_480);
    const jittered = await runResumeRound(store, threadId, 245_481);
    const storedPin = store.get(active.id)?.capacityPin;
    assert.equal(storedPin?.windowTokens, 146_973);
    assert.equal(
      storedPin?.provenance?.match(/seal the session to recover/g)?.length,
      1,
      'a jittered report must replace the note in place, not append a second one',
    );
    assert.match(storedPin?.provenance, /245,481/, 'the stored note carries the latest report number');
    assert.doesNotMatch(storedPin?.provenance, /245,480/, 'the stale report number is replaced');
    assert.equal(
      jittered.capacity.provenance.match(/seal the session to recover/g)?.length,
      1,
      'returned snapshot carries exactly one recovery instruction',
    );
    assert.match(jittered.capacity.provenance, /245,481/);
  });

  it('never reorders concurrent shrinks into an expansion (200K pin, 150K lands, delayed 180K)', async () => {
    // Maintainer P1 probe, one level up from the provenance merge: invocation
    // A reads pin 200000 and prepares a genuine shrink to 180000; invocation
    // B's smaller shrink to 150000 lands first; A's delayed write must not
    // restore 180000. Final pin stays 150000 and A's returned view clamps.
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-shrink-reorder';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-shrink-reorder',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      capacityPin: {
        windowTokens: 200_000,
        inputCeilingTokens: 184_000,
        source: 'reported',
        provenance: 'Carrier reported 200,000 tokens',
        actionable: true,
      },
    });

    const atomicShrink = store.shrinkCapacityPin.bind(store);
    store.shrinkCapacityPin = (id, candidate) => {
      if (candidate.windowTokens === 180_000) {
        // Invocation B's smaller shrink lands while A is paused at the write.
        store.update(id, {
          capacityPin: {
            windowTokens: 150_000,
            inputCeilingTokens: 134_000,
            source: 'reported',
            provenance: 'Carrier reported 150,000 tokens',
            actionable: true,
          },
          updatedAt: Date.now(),
        });
      }
      return atomicShrink(id, candidate);
    };

    const shrunk = await runResumeRound(store, threadId, 180_000);
    const finalPin = store.get(active.id)?.capacityPin;
    assert.equal(finalPin?.windowTokens, 150_000, 'delayed 180K must not overwrite the concurrent 150K');
    assert.equal(
      shrunk.capacity.windowTokens,
      150_000,
      "the losing invocation's returned view clamps to the stored smaller pin",
    );
  });

  it('keeps expansion gated on rollover when no fresh carrier report exists', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-no-report';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-no-report',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    await runResumeRound(store, threadId);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);

    // Member raises the manual cap mid-session; without a carrier report the
    // active session must NOT expand — rollover semantics are preserved.
    registerTestCat(400_000);
    const resolved = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: execJsonService(),
    });
    const pinned = await applyActiveSessionCapacityPin({
      snapshot: resolved,
      catId: TEST_CAT_ID,
      threadId,
      sessionChainStore: store,
    });
    assert.equal(pinned.capacity.windowTokens, EFFECTIVE_WINDOW);
    assert.match(pinned.capacity.provenance, /session-pinned/);
    assert.equal(pinned.nativeWindowTokens, 400_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);
  });

  /**
   * 太阳猫 review P2: the pure snapshot/pin rounds above never cross the
   * production bridge — deleting the `contextNativeWindowTokens` pass-through
   * in invoke-single-cat would not turn them red. This suite drives the full
   * loop per resume round: route-level resolve + pre-pin → invokeSingleCat →
   * real CodexAgentService argv construction (mock spawn) → Codex's effective
   * token_count report (injected contextSnapshotResolver) → post-usage
   * re-pin in the real SessionChainStore.
   */
  describe('production bridge: invokeSingleCat → CodexAgentService argv/report/pin loop', () => {
    const CLI_THREAD_ID = 't-issue-1381-bridge';
    let invokeSingleCat;
    let CodexAgentService;
    let fakeL0Compiler;
    let bridgeGlobalConfigRoot;
    let savedGlobalConfigRoot;
    let savedHome;

    function createMockProcess() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      const originalEmit = emitter.emit.bind(emitter);
      emitter.emit = (event, ...args) => {
        const emitted = originalEmit(event, ...args);
        if (event === 'exit') {
          process.nextTick(() => originalEmit('close', ...args));
        }
        return emitted;
      };
      const proc = {
        stdout,
        stderr,
        stdin: { write: () => true, end: () => {}, on: () => proc.stdin },
        // invoke-single-cat passes a liveness probe; spawnCli checks pid
        // liveness via signal-0, so the mock needs a pid that actually exists.
        // Signals still route through the mocked kill(), and cli-spawn's
        // process.on('exit') SIGKILL guard is neutralized by childExited.
        pid: process.pid,
        exitCode: null,
        kill: mock.fn(() => {
          process.nextTick(() => {
            if (!stdout.destroyed) stdout.end();
            emitter.emit('exit', null, 'SIGTERM');
          });
          return true;
        }),
        on: (event, listener) => {
          emitter.on(event, listener);
          return proc;
        },
        once: (event, listener) => {
          emitter.once(event, listener);
          return proc;
        },
        _emitter: emitter,
      };
      return proc;
    }

    function emitCodexEvents(proc, events) {
      for (const event of events) {
        proc.stdout.write(`${JSON.stringify(event)}\n`);
      }
      setImmediate(() => {
        proc.stdout.end();
        proc._emitter.emit('exit', 0, null);
      });
    }

    async function waitFor(condition, label) {
      const deadline = Date.now() + 10_000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    function parseInjectedNativeWindow(args) {
      for (const arg of args) {
        const match = /^model_context_window=(\d+)$/.exec(arg);
        if (match) return Number(match[1]);
      }
      return null;
    }

    async function collect(iterable) {
      const msgs = [];
      for await (const msg of iterable) msgs.push(msg);
      return msgs;
    }

    before(async () => {
      ({ invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'));
      ({ CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js'));
      ({ fakeL0Compiler } = await import('./helpers/fake-l0-compiler.js'));
      savedGlobalConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      savedHome = process.env.HOME;
      bridgeGlobalConfigRoot = await mkdtemp(join(tmpdir(), 'issue-1381-bridge-global-'));
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = bridgeGlobalConfigRoot;
      process.env.HOME = bridgeGlobalConfigRoot;
    });

    after(async () => {
      if (savedGlobalConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalConfigRoot;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (bridgeGlobalConfigRoot) await rm(bridgeGlobalConfigRoot, { recursive: true, force: true });
    });

    async function withAmbientCodexCarrier(ambientCarrier, run) {
      const savedCarrier = process.env.CAT_CAFE_CODEX_CARRIER;
      process.env.CAT_CAFE_CODEX_CARRIER = ambientCarrier;
      try {
        return await run();
      } finally {
        if (savedCarrier === undefined) delete process.env.CAT_CAFE_CODEX_CARRIER;
        else process.env.CAT_CAFE_CODEX_CARRIER = savedCarrier;
      }
    }

    async function runProductionBridge() {
      // No accountRef: the bridge drives real invoke-single-cat account
      // resolution, which hard-fails on a bound account that does not exist in
      // the isolated global config. Template openai variants also leave
      // accountRef undefined.
      registerTestCat(undefined, undefined, null);
      const store = new SessionChainStore();
      const threadId = 'thread-issue-1381-bridge';
      // cliSessionId matches the Codex thread_id emitted below so the
      // session_init binding takes the same-session path every round.
      const active = store.create({
        cliSessionId: CLI_THREAD_ID,
        threadId,
        catId: TEST_CAT_ID,
        userId: 'user-1',
      });

      let currentProc = null;
      let currentReport = 0;
      let invocationCounter = 0;
      const spawnFn = mock.fn(() => currentProc);
      const service = new CodexAgentService({
        catId: TEST_CAT_ID,
        // This regression owns the exec_json production bridge. Never let a
        // supported ambient app_server setting bypass the injected spawnFn
        // and erase the 12-resume proof.
        carrierMode: 'exec_json',
        l0CompilerFn: fakeL0Compiler,
        spawnFn,
        // resolveCliCommand probes the binary's existence before spawn even
        // with an injected spawnFn, and the real codex CLI is absent on CI
        // runners (codex-agent-service.test.js is not in the public suite, so
        // only this bridge file hits that gate). Point at the running node
        // binary — guaranteed resolvable everywhere; the mock spawnFn means
        // it is never actually executed.
        cliCommand: process.execPath,
        model: 'gpt-5.6-sol',
        auditLog: { append: async () => {} },
        rawArchive: { append: async () => {}, getPath: () => undefined },
        // Simulates Codex's own token_count bookkeeping: whatever native window
        // was injected on argv comes back multiplied by the effective percent.
        contextSnapshotResolver: async () => ({ contextUsedTokens: 1_000, contextWindowTokens: currentReport }),
      });

      const sessionMap = new Map();
      const sessionKey = `user-1:${TEST_CAT_ID}:${threadId}`;
      const deps = {
        registry: {
          create: () => ({
            invocationId: `inv-bridge-${++invocationCounter}`,
            callbackToken: `tok-${invocationCounter}`,
          }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => sessionMap.get(sessionKey),
          getOrCreate: async () => ({}),
          store: async (_userId, _catId, _threadId, sessionId) => {
            sessionMap.set(sessionKey, sessionId);
          },
          delete: async () => {
            sessionMap.delete(sessionKey);
          },
          resolveWorkingDirectory: () => '/tmp/test',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
        sessionChainStore: store,
        // Clowder AI's F296 continuity layer owns the cold/resumed epoch before
        // invokeSingleCat may cross the provider boundary. The upstream
        // clowder-ai bridge predates that home contract, so intake exercises
        // the real in-memory owner instead of bypassing the production seam.
        contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      };

      for (let round = 1; round <= 12; round += 1) {
        // route-serial.ts production sequence: resolve member config → apply the
        // active session pin → invoke with the pinned snapshot.
        const resolved = await resolveInvocationCapacitySnapshot({ catId: TEST_CAT_ID, service });
        const pinnedSnapshot = await applyActiveSessionCapacityPin({
          snapshot: resolved,
          catId: TEST_CAT_ID,
          threadId,
          userId: 'user-1',
          sessionChainStore: store,
        });

        currentProc = createMockProcess();
        const promise = collect(
          invokeSingleCat(deps, {
            catId: TEST_CAT_ID,
            service,
            prompt: `bridge resume round ${round}`,
            userId: 'user-1',
            threadId,
            isLastCat: true,
            capacitySnapshot: pinnedSnapshot,
            // Production contract for codex exec_json resumes: the continuity
            // handshake resolves 'unknown', so the route must supply a prompt
            // rebuild callback (route-serial passes one; without it the
            // invocation throws context_continuity_cold_rebuild_unavailable).
            rebuildPromptAfterSessionSeal: async () => `bridge resume round ${round} (rebuilt)`,
          }),
        );
        // Always drive the mocked CLI to completion before asserting — an
        // assertion thrown while the generator still waits for stdout would
        // leave the invocation timeout timer pending and hang the test process.
        let injected = null;
        let roundError = null;
        try {
          await waitFor(() => spawnFn.mock.calls.length === round, `codex spawn for round ${round}`);
          const args = spawnFn.mock.calls[round - 1].arguments[1];
          injected = parseInjectedNativeWindow(args);
          currentReport = codexEffectiveReport(injected ?? MANUAL_WINDOW);
          emitCodexEvents(currentProc, [
            { type: 'thread.started', thread_id: CLI_THREAD_ID },
            { type: 'turn.completed', usage: { input_tokens: 1_000, output_tokens: 50 } },
          ]);
        } catch (err) {
          roundError = err;
          try {
            currentProc.stdout.end();
            currentProc._emitter.emit('exit', 1, null);
          } catch {
            /* best-effort stream teardown */
          }
        }
        const msgs = await promise;
        if (roundError) throw roundError;
        assert.equal(
          injected,
          MANUAL_WINDOW,
          `round ${round}: argv must inject the config-owned native window ${MANUAL_WINDOW}, ` +
            'never the effective/pinned capacity (the pre-#1381 recursion)',
        );
        assert.ok(
          msgs.some((m) => m.type === 'done'),
          `round ${round}: invocation must complete`,
        );
        assert.ok(!msgs.some((m) => m.type === 'error'), `round ${round}: invocation must not error`);
        assert.equal(
          store.get(active.id)?.capacityPin?.windowTokens,
          EFFECTIVE_WINDOW,
          `round ${round}: session pin must stay at ${EFFECTIVE_WINDOW}, not shrink recursively`,
        );
      }
    }

    for (const ambientCarrier of ['app_server', 'exec_json']) {
      it(
        `keeps the injected Codex argv window at the configured native window across 12 bridge resumes ` +
          `with ambient ${ambientCarrier}`,
        async () => {
          await withAmbientCodexCarrier(ambientCarrier, runProductionBridge);
        },
      );
    }
  });
});
