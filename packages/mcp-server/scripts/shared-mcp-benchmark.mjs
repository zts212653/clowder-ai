/** Matched F333 workload; archives aggregate metrics, never credentials or tool payloads. */
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { collectProcessCensus } from '../../../scripts/mcp-process-census.mjs';
import { guardMcpConfig } from '../dist/secret-mcp-config.js';
import { SHARED_MCP_FAMILIES } from '../dist/shared-invocation-context.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, value] = argument.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const clientsCount = Number(options.clients ?? 3);
const callsCount = Number(options.calls ?? 1000);
const soakMs = Number(options['soak-ms'] ?? 0);
assert.ok(Number.isInteger(clientsCount) && clientsCount > 0 && clientsCount <= 3);
assert.ok(Number.isInteger(callsCount) && callsCount > 0 && callsCount <= 10000);
assert.ok(Number.isFinite(soakMs) && soakMs >= 0 && soakMs <= 3600000);
const families = options.families ? options.families.split(',') : SHARED_MCP_FAMILIES;
assert.ok(families.every((family) => SHARED_MCP_FAMILIES.includes(family)) && families.includes('memory'));
const variants = (options.variants ?? 'split,aggregate,shared').split(',');
assert.ok(variants.every((variant) => ['split', 'aggregate', 'shared'].includes(variant)));
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function artifactFingerprint(directory) {
  const digest = createHash('sha256');
  for (const name of readdirSync(directory, { recursive: true })
    .filter((name) => /\.[cm]?js$/.test(name))
    .sort()) {
    const path = join(directory, name);
    if (!statSync(path).isFile()) continue;
    digest.update(name);
    digest.update(readFileSync(path));
  }
  return digest.digest('hex');
}

function descriptorCounts(pids) {
  const counts = Object.fromEntries(pids.map((pid) => [pid, 0]));
  const output = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-Fpf'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  let pid;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (/^f\d/.test(line) && pid in counts) counts[pid]++;
  }
  return counts;
}

function processCost(roots) {
  const census = collectProcessCensus();
  const owned = new Set(roots);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of census.processes)
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const rows = census.processes.filter((row) => owned.has(row.pid));
  const fds = descriptorCounts(rows.map((row) => row.pid));
  return {
    count: rows.length,
    rssKiB: rows.reduce((sum, row) => sum + row.rssKiB, 0),
    processes: rows.map(({ pid, ppid, rssKiB, category, family }) => ({
      pid,
      ppid,
      rssKiB,
      category,
      family,
      fds: fds[pid],
    })),
  };
}

async function measure(variant) {
  const root = mkdtempSync(join(tmpdir(), 'f333-benchmark-'));
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'LANG', 'TMPDIR'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  const diagnostic = options.diagnostics === '1';
  const host = fork(join(repo, 'packages/api/scripts/shared-mcp-benchmark-host.mjs'), [], {
    cwd: repo,
    env: {
      ...env,
      F333_BENCH_ROOT: root,
      CAT_CAFE_MCP_CREDS_DIR: join(root, 'credentials'),
      CAT_CAFE_DATA_DIR: join(root, 'data'),
      REDIS_URL: 'redis://127.0.0.1:6398',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: diagnostic ? ['--expose-gc', '--cpu-prof', `--cpu-prof-dir=${root}`] : [],
  });
  const waiters = new Map();
  let sequence = 0;
  const ready = new Promise((done, reject) => {
    host.once('error', reject);
    host.once('exit', (code) => {
      if (code) reject(new Error('benchmark host exited'));
    });
    host.on('message', (message) => {
      if (message.ready) done();
      else {
        const waiter = waiters.get(message.id);
        waiters.delete(message.id);
        message.ok ? waiter?.resolve(message.value) : waiter?.reject(new Error(message.error));
      }
    });
  });
  const control = (action, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`benchmark control timeout: ${action}`));
      }, 10000);
      waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      host.send({ id, action, ...extra });
    });
  const clients = [];
  const roots = [host.pid];
  const discovery = [];
  const calls = [];
  const names = [];
  let successfulCalls = 0;
  let result;
  try {
    await ready;
    for (let owner = 0; owner < clientsCount; owner++) {
      const scope = await control('admit', { index: owner });
      if (options.probe === '1') process.stdout.write(`${JSON.stringify(await control('probe', { index: owner }))}\n`);
      const serverFamilies = variant === 'aggregate' ? ['index'] : families;
      for (const family of serverFamilies) {
        const descriptor = guardMcpConfig(
          {
            command: process.execPath,
            args: [join(repo, `packages/mcp-server/dist/${family}.js`)],
            env: { ALLOWED_WORKSPACE_DIRS: scope.workspaceRoot },
          },
          {
            CAT_CAFE_API_URL: scope.apiUrl,
            CAT_CAFE_CREDENTIAL_FILE: scope.credentialFile,
            CAT_CAFE_DATA_DIR: join(root, 'data'),
            CAT_CAFE_MCP_TRANSPORT: variant === 'shared' ? 'shared' : 'stdio',
          },
        );
        const transport = new StdioClientTransport({
          command: descriptor.command,
          args: descriptor.args,
          env: descriptor.env,
          cwd: scope.workspaceRoot,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', () => {});
        const client = new Client({ name: 'f333-benchmark', version: '1' });
        clients.push({ client, family, owner });
        const start = performance.now();
        await client.connect(transport);
        const tools = await client.listTools();
        discovery.push(performance.now() - start);
        if (transport.pid) roots.push(transport.pid);
        names.push({
          owner,
          family,
          names: tools.tools.map((tool) => tool.name).sort(),
          schemaHash: hash(tools.tools),
          instructionsHash: hash(client.getInstructions() ?? ''),
        });
      }
    }
    const readers = clients.filter(({ family }) => family === 'memory' || family === 'index');
    const call = async (reader) => {
      const start = performance.now();
      const result = await reader.client.callTool({
        name: 'cat_cafe_read_file_slice',
        arguments: { path: 'document.txt', startLine: 1 },
      });
      calls.push(performance.now() - start);
      assert.ok(!result.isError && JSON.stringify(result).includes(`fixture owner ${reader.owner}`));
      successfulCalls++;
    };
    for (let offset = 0; offset < callsCount; offset += readers.length * 4) {
      await Promise.all(
        Array.from({ length: Math.min(readers.length * 4, callsCount - offset) }, (_, index) =>
          call(readers[index % readers.length]),
        ),
      );
    }
    const active = processCost(roots);
    const gcDiagnostic = diagnostic ? await control('diagnostic-gc') : undefined;
    const samples = [];
    const startSoak = Date.now();
    let nextSample = startSoak;
    while (Date.now() - startSoak < soakMs) {
      await Promise.all(readers.flatMap((reader) => Array.from({ length: 4 }, () => call(reader))));
      if (Date.now() >= nextSample) {
        samples.push({ elapsedMs: Date.now() - startSoak, ...processCost(roots), host: await control('resources') });
        nextSample = Date.now() + 5000;
      }
      await pause(1000);
    }
    await Promise.all(clients.map(({ client }) => client.close()));
    await pause(10000);
    const settled = processCost([host.pid]);
    const hostResources = await control('resources');
    result = {
      variant,
      clientsCount,
      families,
      callsRequested: callsCount,
      callsSucceeded: successfulCalls,
      discoveryP95Ms: quantile(discovery, 0.95),
      callP95Ms: quantile(calls, 0.95),
      active,
      settled,
      hostResources,
      toolSurfaces: names,
      soak: { durationMs: Date.now() - startSoak, samples },
      ...(gcDiagnostic ? { diagnosticOnly: { gc: gcDiagnostic } } : {}),
    };
  } finally {
    await Promise.allSettled(clients.map(({ client }) => client.close()));
    try {
      await control('close');
    } catch {
      host.kill('SIGTERM');
    }
    if (host.exitCode === null) await Promise.race([new Promise((done) => host.once('exit', done)), pause(2000)]);
    if (host.exitCode === null) host.kill('SIGKILL');
    if (diagnostic && result) {
      const profile = readdirSync(root).find((name) => name.endsWith('.cpuprofile'));
      if (profile) {
        const data = JSON.parse(readFileSync(join(root, profile), 'utf8'));
        result.diagnosticOnly.cpu = data.nodes
          .filter((node) => node.hitCount)
          .sort((left, right) => right.hitCount - left.hitCount)
          .slice(0, 30)
          .map((node) => ({
            function: node.callFrame.functionName,
            url: node.callFrame.url.replace(repo, '.'),
            hits: node.hitCount,
          }));
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
  return result;
}

const report = {
  v: 1,
  capturedAt: new Date().toISOString(),
  checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  loadedArtifacts: {
    api: artifactFingerprint(join(repo, 'packages/api/dist')),
    mcp: artifactFingerprint(join(repo, 'packages/mcp-server/dist')),
  },
  metric: 'matched sum RSS KiB; process-owned resources only, common SDK driver excluded; not unique physical RAM',
  results: [],
};
for (const variant of variants) {
  const result = await measure(variant);
  report.results.push(result);
  if (options.output) {
    const output = resolve(options.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2));
  }
  process.stdout.write(
    `${JSON.stringify({ variant, count: result.active.count, rssKiB: result.active.rssKiB, callP95Ms: result.callP95Ms, discoveryP95Ms: result.discoveryP95Ms, callsSucceeded: result.callsSucceeded })}\n`,
  );
}
