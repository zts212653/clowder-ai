import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  probePortBindability,
  resolveServiceScriptPath,
  waitForPortBindable,
} from '../dist/domains/services/service-lifecycle.js';
import { servicesRoutes } from '../dist/routes/services.js';

const SESSION_HEADERS = { 'x-test-session-user': 'you' };

function buildIsolatedTestEnv(baseEnv = process.env) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !/^CAT_CAFE_SERVICE_.*_ENABLED$/.test(key)));
  for (const key of [
    'ASR_ENABLED',
    'TTS_ENABLED',
    'EMBED_ENABLED',
    'LLM_POSTPROCESS_ENABLED',
    'AUDIO_SERVICE_ENABLED',
  ]) {
    delete env[key];
  }
  env.CAT_CAFE_PROFILE = 'test';
  env.CAT_CAFE_SERVICE_ASR_ENABLED = '0';
  env.ASR_ENABLED = '0';
  return env;
}

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  const testEnv = options.env === undefined ? buildIsolatedTestEnv(process.env) : options.env;
  await app.register(servicesRoutes, {
    ...options,
    env: testEnv,
    fetchHealth:
      options.fetchHealth ??
      (async () => ({
        ok: false,
        status: 503,
        error: 'unreachable',
      })),
  });
  await app.ready();
  return app;
}

function restoreOwner(previousOwner) {
  if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
}

function createAuditLog() {
  const events = [];
  return {
    events,
    auditLog: {
      append: async (input) => {
        events.push(input);
        return input;
      },
      readByType: async (type) => events.filter((event) => event.type === type),
    },
  };
}

describe('startup reconciler port-bind race (F195)', () => {
  // Test 1: Reproduces the UAT failure (immediate EADDRINUSE path).
  // Old process on port → kill succeeds → lsof sees nothing (port "clear")
  // → first spawn fails because port is still kernel-bound → retry succeeds.
  it('retries start when port appears clear by lsof but spawn fails with address-in-use', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog } = createAuditLog();

    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const whisperApiScript = resolvedScript.replace(/whisper-server\.sh$/, 'whisper-api.py');

    let killCalls = 0;
    let runCalls = 0;
    let isOldProcessAlive = true;

    const app = await buildApp({
      lifecycle: {
        auditLog,
        startupReadinessTimeoutMs: 500,
        startupProbeIntervalMs: 10,
        findPidsByPort: async (port) => {
          if (port !== 9876) return [];
          // After the old process is killed, lsof sees nothing
          // (socket left LISTEN → hypothesized TIME_WAIT/gone,
          // invisible to -sTCP:LISTEN)
          if (!isOldProcessAlive) return [];
          return [9999]; // old stale PID
        },
        readProcessCommand: async (pid) => {
          if (pid === 9999) return `python3 ${whisperApiScript} --model base --port 9876`;
          return null;
        },
        killPid: (pid) => {
          killCalls++;
          if (pid === 9999) isOldProcessAlive = false;
        },
        isProcessAlive: (pid) => {
          if (pid === 9999) return isOldProcessAlive;
          return false;
        },
        runScript: async (input) => {
          runCalls++;
          if (input.serviceId === 'whisper-stt') {
            if (runCalls === 1) {
              // First attempt: port still kernel-bound → EADDRINUSE
              return { code: 1, output: 'OSError: [Errno 48] Address already in use' };
            }
            // After retry, second attempt succeeds
            return { code: null, pid: 7777, output: 'started' };
          }
          return { code: 0, output: '' };
        },
        serviceConfig: {
          get: () => ({ installed: true, enabled: true, selectedModel: 'base' }),
          set: () => {},
        },
      },
    });
    try {
      const start = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      const body = JSON.parse(start.payload);
      assert.equal(body.ok, true, `expected successful start after port-bind retry, got: ${JSON.stringify(body)}`);
      assert.ok(killCalls > 0, 'should have killed old process');
      assert.ok(runCalls >= 2, `expected at least 2 run attempts (initial + retry), got ${runCalls}`);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  // Test 2: Reconciler outer retry (P1-2 fix).
  // Inner retry has PORT_CONTENTION_MAX_RETRIES = 3, so a single startService
  // call runs up to 4 runner attempts (initial + 3 retries). To exercise the
  // OUTER reconciler retry, we must fail all 4 inner attempts so startService
  // returns a failure, forcing the reconciler to retry at the outer level.
  // On the reconciler's second round, the first inner attempt succeeds.
  it('reconciler outer retry fires after inner retry exhausts on transient port contention', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    let runCalls = 0;
    const configs = new Map([['whisper-stt', { installed: true, enabled: true, selectedModel: 'base' }]]);

    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 200,
        startupProbeIntervalMs: 10,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async (input) => {
          if (input.serviceId !== 'whisper-stt') return { code: 0, output: '' };
          runCalls++;
          // Inner retry: PORT_CONTENTION_MAX_RETRIES = 3 → 4 attempts per
          // startService call (initial + 3 retries). Fail all 4 so inner
          // retry exhausts and startService returns failure to reconciler.
          if (runCalls <= 4) {
            return { code: 1, output: 'OSError: [Errno 48] Address already in use' };
          }
          // Attempt 5+: reconciler's second round, first inner attempt — succeed
          return { code: null, pid: 8888, output: 'started' };
        },
      },
      // fetchHealth returns ok on 5th+ runCall so readiness passes after
      // the successful spawn in reconciler round 2.
      fetchHealth: async () => {
        if (runCalls >= 5) return { ok: true, status: 200, error: null };
        return { ok: false, status: 503, error: 'unreachable' };
      },
    });
    try {
      // Inner retry: 4 calls (initial + 3 retries), all fail → startService fails
      // Reconciler outer retry backoff (2s), then new startService:
      //   call 5 → succeed → readiness probes → OK
      // Total expected: 5+ calls, with the 5th from reconciler's SECOND round.
      for (let i = 0; i < 300 && runCalls < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(
        runCalls >= 5,
        `reconciler outer retry should fire after inner retry exhausts (4 fails), ` +
          `but only ${runCalls} runner call(s) were made. ` +
          `If runCalls <= 4, the outer reconciler retry never fired.`,
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  // Test 3: Settlement path — detached runner returns code:null, then dies
  // with EADDRINUSE via settlement (P1-1 fix).
  // This is the "completed-before-readiness" gap: runner starts OK (code: null),
  // startService returns {ok: true} to reconciler, but the process dies with
  // EADDRINUSE during the grace period. The reconciler must detect the late
  // failure (process died — no PIDs on port) and retry.
  //
  // Critical: the port contention CLEARS before readiness timeout. This
  // covers the race @gpt52 identified: a one-shot probePortBindability at
  // timeout would see "bindable" and miss the late failure. The reconciler
  // instead checks whether any process is still listening (findPidsByPort).
  it('reconciler detects late EADDRINUSE even when contention clears before readiness timeout', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    let runCalls = 0;
    const configs = new Map([['whisper-stt', { installed: true, enabled: true, selectedModel: 'base' }]]);

    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 300,
        startupProbeIntervalMs: 10,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        // No owned process in process table after first attempt dies —
        // this is the key signal the reconciler uses (command matching
        // via findOwnedServiceProcessPids, not port listener check).
        findPidsByPort: async () => [],
        listProcesses: async () => [],
        readProcessCommand: async () => null,
        runScript: async (input) => {
          if (input.serviceId !== 'whisper-stt') return { code: 0, output: '' };
          runCalls++;
          if (runCalls === 1) {
            // First attempt: runner starts OK (detached, code: null), but
            // settlement reveals EADDRINUSE after 50ms — simulating the
            // real scenario where the process crashes on bind(). The port
            // contention clears immediately (no blocking server), so a
            // probePortBindability at timeout would see "bindable" and
            // miss this failure.
            return {
              code: null,
              pid: 9999,
              output: 'starting whisper...',
              settlement: new Promise((resolve) =>
                setTimeout(
                  () => resolve({ code: 1, output: 'OSError: [Errno 48] Address already in use', pid: 9999 }),
                  50,
                ),
              ),
            };
          }
          // Second attempt: succeeds
          return { code: null, pid: 8888, output: 'started' };
        },
      },
      fetchHealth: async () => {
        // After 2nd run, service becomes ready
        if (runCalls >= 2) return { ok: true, status: 200, error: null };
        return { ok: false, status: 503, error: 'unreachable' };
      },
    });
    try {
      // State machine timeline:
      // t=0:    reconciler calls startService
      // t=0:    runScript returns {code:null, settlement: ...}
      // t=0:    startService returns {ok:true} to reconciler
      // t=50:   settlement resolves with EADDRINUSE (process died)
      //         Port contention ALREADY CLEARED (no blocking server)
      // t=300:  readiness timeout — service never became ready
      // t=300:  reconciler checks findOwnedServiceProcessPids → [] → process dead → retry
      // t=300+: backoff → runScript call 2 succeeds → readiness OK → done
      for (let i = 0; i < 300 && runCalls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(
        runCalls >= 2,
        `reconciler should detect late failure via process-death signal and retry, ` +
          `but only ${runCalls} runner call(s) were made. ` +
          `If runCalls === 1, the reconciler missed the late EADDRINUSE.`,
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  // Test 3b: Slow-start double-spawn guard (P1-5 fix).
  // Process is alive (loading model) but hasn't bound the port yet at readiness
  // timeout. findPidsByPort returns [] (no listener), but findOwnedServiceProcessPids
  // returns the process via command matching. The reconciler must NOT retry —
  // retrying would double-spawn the service.
  it('reconciler does not retry when owned process is alive but not yet listening', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    let runCalls = 0;
    const configs = new Map([['whisper-stt', { installed: true, enabled: true, selectedModel: 'base' }]]);
    const whisperScriptPath = resolveServiceScriptPath('scripts/services/whisper-server.sh');

    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 200,
        startupProbeIntervalMs: 10,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        // No listener on port — process hasn't called bind() yet.
        findPidsByPort: async () => [],
        // But the process IS alive — command matches whisper-stt start script.
        // This simulates a Qwen/Whisper model-loading phase before uvicorn.run().
        listProcesses: async () => (runCalls >= 1 ? [{ pid: 9999, command: `bash ${whisperScriptPath}` }] : []),
        readProcessCommand: async () => null,
        runScript: async (input) => {
          if (input.serviceId !== 'whisper-stt') return { code: 0, output: '' };
          runCalls++;
          // Process starts OK (detached, code: null), model loading takes
          // longer than readiness timeout — never binds port in time.
          return { code: null, pid: 9999, output: 'loading model...' };
        },
      },
      // Health never becomes OK — simulates model still loading.
      fetchHealth: async () => ({ ok: false, status: 503, error: 'model loading' }),
    });
    try {
      // State machine timeline:
      // t=0:    reconciler calls startService → code:null, pid:9999
      // t=200:  readiness timeout — service never became ready
      // t=200:  reconciler checks findOwnedServiceProcessPids → [9999] → alive
      // t=200:  reconciler breaks — does NOT retry (avoids double-spawn)
      // Wait long enough for a hypothetical second attempt to fire
      for (let i = 0; i < 50 && runCalls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.equal(
        runCalls,
        1,
        `reconciler should NOT retry when owned process is alive but pre-bind ` +
          `(slow model loading). Got ${runCalls} runner call(s) — ` +
          `if runCalls > 1, the reconciler double-spawned the service.`,
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  // Test 4: Reconciler does NOT retry permanent failures (P1-3 fix).
  // Invalid config or non-transient errors should NOT trigger retry.
  it('reconciler does not retry non-transient failures', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    let runCalls = 0;
    const configs = new Map([['whisper-stt', { installed: true, enabled: true, selectedModel: 'base' }]]);

    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 200,
        startupProbeIntervalMs: 10,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async (input) => {
          if (input.serviceId !== 'whisper-stt') return { code: 0, output: '' };
          runCalls++;
          // Always fail with a NON-port-contention error (e.g. missing dependency)
          return { code: 1, output: 'ModuleNotFoundError: No module named torch' };
        },
      },
      fetchHealth: async () => ({ ok: false, status: 503, error: 'unreachable' }),
    });
    try {
      // Wait enough for reconciler to fire and potentially retry
      for (let i = 0; i < 80 && runCalls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Give extra time in case retries are happening
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Inner retry should NOT fire (error doesn't match PORT_CONTENTION_PATTERN).
      // Reconciler should NOT retry (error is not transient port contention).
      // So total calls should be exactly 1 (initial attempt only).
      assert.equal(
        runCalls,
        1,
        `reconciler should not retry non-transient failures, but made ${runCalls} runner call(s). ` +
          `Expected exactly 1 (no retry for permanent errors).`,
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  // Test 5: probePortBindability unit test.
  // Verifies the probe correctly detects both bindable and occupied ports.
  it('probePortBindability detects occupied vs free ports', async () => {
    // First: probe an ephemeral port that should be free
    const freeProbe = await probePortBindability(0); // port 0 = OS picks a free port
    assert.equal(freeProbe.bindable, true, 'port 0 (OS-assigned) should always be bindable');

    // Second: occupy a port and verify probe detects it
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    const occupiedPort = server.address().port;

    try {
      const occupiedProbe = await probePortBindability(occupiedPort);
      assert.equal(occupiedProbe.bindable, false, `port ${occupiedPort} should not be bindable while occupied`);
      assert.equal(occupiedProbe.error, 'EADDRINUSE');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // Third: after closing, port should become bindable again
    const freedProbe = await probePortBindability(occupiedPort);
    assert.equal(freedProbe.bindable, true, `port ${occupiedPort} should be bindable after server close`);
  });

  // Test 6: waitForPortBindable polls until port is released.
  it('waitForPortBindable waits until port becomes free', async () => {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    const port = server.address().port;

    // Close the server after 200ms
    setTimeout(() => server.close(), 200);

    const result = await waitForPortBindable(port, {
      timeoutMs: 3_000,
      intervalMs: 50,
    });

    assert.equal(result.ok, true, 'should eventually succeed after server closes');
  });

  // Test 7: waitForPortBindable times out when port stays occupied.
  it('waitForPortBindable times out when port stays occupied', async () => {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    const port = server.address().port;

    try {
      const result = await waitForPortBindable(port, {
        timeoutMs: 500,
        intervalMs: 50,
      });

      assert.equal(result.ok, false, 'should timeout when port stays occupied');
      assert.equal(result.reason, 'bind-timeout');
      assert.equal(result.lastError, 'EADDRINUSE');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
