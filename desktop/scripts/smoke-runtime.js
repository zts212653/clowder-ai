#!/usr/bin/env node
/**
 * Start the INSTALLED desktop runtime and verify it actually serves.
 *
 * This is the check the rest of the suite cannot make. Everything else stops at
 * "the files are in place"; here the bundled Redis, the API and Next.js are
 * started exactly the way the shell starts them, and then the Web UI and the API
 * are polled over HTTP — including a request through the Web origin's /api
 * rewrite, which is what proves the routes-manifest retarget took effect on a
 * real install.
 *
 * It deliberately does NOT launch Electron. Electron needs a display, while the
 * risky startup logic (port resolution, Redis ownership, manifest retarget,
 * startup order) lives in ServiceManager and runs under plain Node.
 *
 * Usage:
 *   node desktop/scripts/smoke-runtime.js --root <install root> [--timeout 180] [--manager <path>]
 *
 * Exit codes: 0 = the runtime served, 1 = it did not (details on stderr), 2 = bad usage.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported so they can be unit-tested without a running app)
// ---------------------------------------------------------------------------

/** The HTTP probes the smoke performs, in the order that fails fastest. */
function buildProbeUrls({ frontendPort, apiPort }) {
  const web = `http://127.0.0.1:${frontendPort}`;
  const api = `http://127.0.0.1:${apiPort}`;
  return [
    { id: 'api-direct', url: `${api}/api/health`, why: 'the API must answer on its own port' },
    {
      id: 'api-through-web',
      url: `${web}/api/health`,
      why: 'the built rewrites must reach the API — this is what proves the manifest retarget',
    },
    { id: 'web-ui', url: `${web}/`, why: 'the Next.js UI must serve' },
  ];
}

/** Turn probe outcomes into a pass/fail verdict. */
function judgeProbes(results) {
  const failures = results.filter((result) => !result.ok).map((result) => ({ id: result.id, detail: result.detail }));
  return { ok: failures.length === 0, failures };
}

/** Where the shell's own ServiceManager lives inside an installed tree. */
function resolveManagerPath(root, explicit) {
  if (explicit) return explicit;
  return path.join(root, 'desktop-dist', 'resources', 'app', 'service-manager.js');
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { root: null, manager: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--manager') args.manager = argv[++i];
    else if (argv[i] === '--timeout') args.timeoutMs = Number(argv[++i]) * 1000;
    else fail(`Unknown flag: ${argv[i]}`, 2);
  }
  if (!args.root) {
    fail('Usage: smoke-runtime.js --root <install root> [--timeout <seconds>] [--manager <path>]', 2);
  }
  return args;
}

async function probeOnce(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    let body = '';
    try {
      body = (await response.text()).slice(0, 200);
    } catch {}
    return { ok: response.ok, detail: `HTTP ${response.status}${body ? ` — ${body}` : ''}` };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}

/** Poll every probe until each passes or the deadline expires. */
async function waitForProbes(probes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const latest = new Map();

  while (Date.now() < deadline) {
    let allPassed = true;
    for (const probe of probes) {
      if (latest.get(probe.id)?.ok) continue;
      const outcome = await probeOnce(probe.url);
      latest.set(probe.id, { ...probe, ...outcome });
      if (outcome.ok) process.stdout.write(`  [OK]   ${probe.id} — ${probe.url}\n`);
      else allPassed = false;
    }
    if (allPassed) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return probes.map((probe) => latest.get(probe.id) ?? { ...probe, ok: false, detail: 'not attempted' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  if (!fs.existsSync(root)) fail(`Install root not found: ${root}`, 2);

  const managerPath = resolveManagerPath(root, args.manager);
  if (!fs.existsSync(managerPath)) {
    fail(
      `Cannot find the desktop ServiceManager at ${managerPath}.\n` +
        '  why: this script drives the INSTALLED runtime, and the installed shell lives under desktop-dist/resources/app.\n' +
        '  fix: pass --root pointing at an installed Clowder AI tree, or --manager at a built desktop tree.',
      2,
    );
  }

  process.stdout.write(`Runtime smoke: ${root}\n  manager: ${managerPath}\n`);

  // The installed manager is plain CommonJS and expects no Electron at load time.
  const ServiceManager = require(managerPath);
  const services = new ServiceManager(root, { onStatus: (message) => process.stdout.write(`  [status] ${message}\n`) });

  let started = false;
  try {
    await services.prepareRuntime();
    const resolved = services.getRuntimeStatus();
    process.stdout.write(`  resolved ports: web=${resolved.frontendPort} api=${resolved.apiPort}\n`);

    await services.startAll();
    started = true;

    const probes = buildProbeUrls({ frontendPort: resolved.frontendPort, apiPort: resolved.apiPort });
    process.stdout.write(`  waiting up to ${Math.round(args.timeoutMs / 1000)}s for ${probes.length} probes\n`);
    const results = await waitForProbes(probes, args.timeoutMs);
    const verdict = judgeProbes(results);
    const status = services.getRuntimeStatus();
    process.stdout.write(`  redis: memoryMode=${status.memoryMode} port=${status.redisPort}\n`);

    if (!verdict.ok) {
      process.stderr.write(`\nThe installed runtime did NOT serve (${verdict.failures.length} probe(s) failed):\n`);
      for (const failure of verdict.failures) process.stderr.write(`  - ${failure.id}: ${failure.detail}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('\nInstalled runtime served: API, Web UI and the /api rewrite all answered.\n');
    }
  } catch (error) {
    process.stderr.write(`\nThe installed runtime failed to start: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  } finally {
    if (started) {
      process.stdout.write('  stopping services...\n');
      await services.stopAll().catch((error) => process.stderr.write(`  stopAll failed: ${error.message}\n`));
    }
  }

  process.exit(process.exitCode ?? 0);
}

module.exports = { buildProbeUrls, judgeProbes, resolveManagerPath };

if (require.main === module) main();
