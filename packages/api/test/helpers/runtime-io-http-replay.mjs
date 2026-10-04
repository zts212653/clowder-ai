/** Isolated production-function replay. Never touches runtime, Redis, or a network Git remote. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  listListenPortsViaLsof,
  listProcessesViaPs,
} from '../../dist/domains/cats/services/agents/providers/antigravity/antigravity-ls-discovery.js';
import { getMemoizedMcpHostVersion } from '../../dist/domains/cats/services/agents/providers/mcp-schema-delivery-capability.js';
import { CanonicalTasteMemoryCueSource } from '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { clearEnvironmentCache, getEnvironmentProfile } from '../../dist/domains/services/environment-detector.js';
import { FileTasteRepository } from '../../dist/domains/taste/services/TasteRepository.js';
import { installPlugin, uninstallPlugin } from '../../dist/infrastructure/connectors/plugins/plugin-installer.js';
import { PromptCaptureStore } from '../../dist/infrastructure/debug/prompt-capture-store.js';
import { loadEvalHubSummaryAsync } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { fetchAndCreateMainReader } from '../../dist/infrastructure/harness-eval/publish-verdict/publication/replay-detection.js';

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixture = await mkdtemp(join(tmpdir(), 'cat-cafe-io-http-replay-'));
const previousPath = process.env.PATH;
const bin = join(fixture, 'bin');
const tasteRoot = join(fixture, 'taste');
const output = process.argv[2];
const report = {
  at: new Date().toISOString(),
  worktree: repoRoot,
  isolated: true,
  productionTouched: false,
  results: [],
};
let operation;
const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(await operation()));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  }
});
async function executable(name, source) {
  const path = join(bin, name);
  await writeFile(path, `#!${process.execPath}\n${source}\n`);
  await chmod(path, 0o755);
}
async function measure(id, run, summarize = (result) => result) {
  operation = run;
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const samples = [];
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let done = false;
  const started = performance.now();
  const response = fetch(`${origin}/work`)
    .then(async (response) => {
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    })
    .finally(() => {
      done = true;
    });
  while (!done) {
    const before = performance.now();
    assert.equal(await (await fetch(`${origin}/health`)).text(), 'ok');
    samples.push(performance.now() - before);
    await delay(10);
  }
  const result = await response;
  lag.disable();
  samples.sort((a, b) => a - b);
  const item = {
    id,
    operationMs: +(performance.now() - started).toFixed(2),
    healthRequests: samples.length,
    healthMaxMs: +Math.max(...samples).toFixed(2),
    healthP95Ms: +(samples[Math.floor(samples.length * 0.95)] ?? 0).toFixed(2),
    eventLoopMaxMs: +(lag.max / 1e6).toFixed(2),
    result: summarize(result),
  };
  report.results.push(item);
  assert.ok(item.healthMaxMs < 250, `${id}: health response exceeded 250 ms`);
  assert.ok(item.eventLoopMaxMs < 250, `${id}: event loop exceeded 250 ms`);
  console.log(JSON.stringify(item));
}
try {
  await mkdir(bin);
  await mkdir(join(tasteRoot, 'docs/taste/vignettes'), { recursive: true });
  for (let i = 0; i < 88; i++)
    await writeFile(
      join(tasteRoot, `docs/taste/vignettes/${i}.md`),
      `---\nwhen: fixture\nquotes: []\nscene: decision ${i}\ntags: [fixture]\ndimension: cognitive-honesty\n---\n`,
    );
  await executable(
    'git',
    `const a=process.argv.slice(2); setTimeout(()=>{ if(a.includes('rev-parse')) console.log(a.includes('origin/main') ? '${'a'.repeat(40)}' : ${JSON.stringify(tasteRoot)}); else if(a.includes('worktree')) process.stdout.write(a.includes('-z') ? 'worktree '+${JSON.stringify(tasteRoot)}+'\\0branch refs/heads/main\\0' : 'worktree '+${JSON.stringify(tasteRoot)}+'\\nHEAD ${'a'.repeat(40)}\\nbranch refs/heads/main\\n'); else if(a.includes('ls-tree')) console.log('fixture-bundle'); else if(a.includes('show')) console.log('fixture-source'); }, a.includes('fetch') ? 400 : 50);`,
  );
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'])
    await executable(name, `setTimeout(()=>console.log('arm64\\n3.12.1'),100)`);
  await executable('fixture-provider', `setTimeout(()=>console.log('fixture-cli 1.2.3'),400)`);
  await executable('ps', `setTimeout(()=>console.log('123 language_server --csrf_token fixture'),150)`);
  await executable('lsof', `setTimeout(()=>console.log('language_server 123 TCP *:18888 (LISTEN)'),150)`);
  const pluginRoot = join(fixture, 'plugins');
  const packageRoot = join(fixture, 'archive/fixture-plugin');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'connector.yaml'), 'id: fixture-plugin\nname: Fixture\n');
  await writeFile(join(packageRoot, 'index.js'), 'export default {};');
  for (let i = 0; i < 1500; i++) await writeFile(join(packageRoot, `${i}.txt`), 'fixture');
  const archive = join(fixture, 'plugin.tar.gz');
  await exec('tar', ['czf', archive, '-C', join(fixture, 'archive'), 'fixture-plugin']);
  const captures = new PromptCaptureStore({ baseDir: join(fixture, 'captures') });
  const capture = {
    captureId: randomUUID(),
    invocationId: 'fixture',
    catId: 'fixture',
    threadId: 'fixture',
    userId: 'owner',
    model: 'fixture',
    capturedAt: Date.now(),
    systemPrompt: '',
    userPrompt: '',
    effectivePrompt: 'x'.repeat(8 * 1024 * 1024),
    injectionDecision: { isResume: false, canSkipOnResume: false, forceReinjection: false, injected: false },
    promptBytes: 8 * 1024 * 1024,
    tokenEstimate: 0,
  };
  captures.captureSync(capture);
  process.env.PATH = `${bin}:${previousPath}`;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  report.origin = `http://127.0.0.1:${server.address().port}`;
  await measure('R06', async () => {
    const source = new CanonicalTasteMemoryCueSource(new FileTasteRepository(tasteRoot), 'owner');
    const ref = await source.resolve({
      ownerUserId: 'owner',
      stage: 'review',
      selectedSkill: 'request-review',
      featureId: 'F1',
    });
    const result = await source.read({
      ownerUserId: 'owner',
      anchor: 'taste-dimensions:cognitive-honesty',
      expectedRevision: ref.revision,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.payload.totalCount, 88);
    return { count: result.payload.totalCount };
  });
  await measure('R07', async () => {
    const summary = await loadEvalHubSummaryAsync({ harnessFeedbackRoot: join(repoRoot, 'docs/harness-feedback') });
    assert.ok(summary.counts.total > 100);
    return summary.counts;
  });
  await measure('R08', async () => {
    const reader = await fetchAndCreateMainReader(fixture);
    assert.ok(reader);
    assert.equal((await reader.readFile('verdicts/fixture.md')).trim(), 'fixture-source');
    return { bundles: (await reader.listBundleEntries()).length };
  });
  await measure('R09', async () => {
    clearEnvironmentCache();
    const [a, b] = await Promise.all([getEnvironmentProfile(true), getEnvironmentProfile(true)]);
    assert.equal(a, b);
    return { os: a.os, arch: a.arch, sharedProbe: true };
  });
  await measure('R10', async () => {
    const [a, b] = await Promise.all([
      getMemoizedMcpHostVersion(join(bin, 'fixture-provider')),
      getMemoizedMcpHostVersion(join(bin, 'fixture-provider')),
    ]);
    assert.equal(a, '1.2.3');
    assert.equal(a, b);
    assert.equal((await listProcessesViaPs()).length, 1);
    assert.deepEqual(await listListenPortsViaLsof('123'), [18888]);
    return { version: a, discovery: true };
  });
  await measure(
    'R11',
    async () => {
      const result = await captures.read(capture.captureId, 'owner');
      assert.equal(result.effectivePrompt.length, 8 * 1024 * 1024);
      assert.equal(await captures.read(capture.captureId, 'foreign'), null);
      await captures.prune();
      return result;
    },
    (result) => ({ payloadBytes: result.effectivePrompt.length, ownerVerified: true }),
  );
  await measure('R12', async () => {
    const installed = await installPlugin(pluginRoot, archive, new Set());
    assert.equal(installed.action, 'installed');
    const uninstalled = await uninstallPlugin(pluginRoot, 'fixture-plugin');
    assert.equal(uninstalled.action, 'uninstalled');
    return { files: 1502, install: installed.action, uninstall: uninstalled.action };
  });
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
} finally {
  process.env.PATH = previousPath;
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(fixture, { recursive: true, force: true });
}
